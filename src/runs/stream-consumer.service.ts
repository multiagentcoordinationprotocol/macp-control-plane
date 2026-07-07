import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { RunDescriptor } from '../contracts/control-plane';
import { RawRuntimeEvent, RuntimeSessionHandle } from '../contracts/runtime';
import { AppConfigService } from '../config/app-config.service';
import { EventNormalizerService } from '../events/event-normalizer.service';
import { RunEventService } from '../events/run-event.service';
import { StreamHubService } from '../events/stream-hub.service';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { TraceService } from '../telemetry/trace.service';
import { RuntimeProviderRegistry } from '../runtime/runtime-provider.registry';
import { RuntimeSessionRepository } from '../storage/runtime-session.repository';
import { RunManagerService } from './run-manager.service';

interface ActiveStream {
  aborted: boolean;
  finalized: boolean;
  connected: boolean;
  lastProcessedSeq: number;
  /**
   * 1-based count of accepted envelopes delivered on the per-session
   * StreamSession for this run — the runtime's `after_sequence` ordinal used to
   * resume the stream after a disconnect (T7). Only session-stream envelopes
   * increment it; ambient signals, snapshots, and stream-status frames do not.
   */
  envelopeOrdinal: number;
  /** True once a compacted-history gap forced a degrade to poll-only. */
  historyGap?: boolean;
  finalizingPromise?: Promise<void>;
  /** Tracks the consumeLoop so shutdown can await in-flight persistence. */
  loopPromise?: Promise<void>;
}

@Injectable()
export class StreamConsumerService implements OnModuleDestroy {
  private readonly logger = new Logger(StreamConsumerService.name);
  private readonly active = new Map<string, ActiveStream>();

  constructor(
    private readonly runtimeRegistry: RuntimeProviderRegistry,
    private readonly normalizer: EventNormalizerService,
    private readonly eventService: RunEventService,
    private readonly runtimeSessionRepository: RuntimeSessionRepository,
    private readonly runManager: RunManagerService,
    private readonly streamHub: StreamHubService,
    private readonly config: AppConfigService,
    private readonly instrumentation: InstrumentationService,
    private readonly traceService: TraceService
  ) {}

  async onModuleDestroy(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const [runId, marker] of this.active) {
      marker.aborted = true;
      this.logger.log(`aborting stream for run ${runId} on shutdown`);
      if (marker.loopPromise) pending.push(marker.loopPromise);
    }
    // Bounded drain: wait for consumeLoops to observe abort and finish any
    // in-flight persistRawAndCanonical before returning, so the DB pool
    // isn't closed under them. Capped to avoid blocking shutdown on stuck
    // gRPC calls.
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => setTimeout(resolve, 2000))
    ]);
  }

  async start(params: {
    runId: string;
    execution: RunDescriptor;
    runtimeKind: string;
    runtimeSessionId: string;
    subscriberId: string;
    resumeFromSeq?: number;
    resumeFromEnvelopeOrdinal?: number;
    sessionHandle?: RuntimeSessionHandle;
    pollOnly?: boolean;
  }): Promise<void> {
    if (this.active.has(params.runId)) return;
    const marker: ActiveStream = {
      aborted: false,
      finalized: false,
      connected: false,
      lastProcessedSeq: params.resumeFromSeq ?? 0,
      envelopeOrdinal: params.resumeFromEnvelopeOrdinal ?? 0
    };
    this.active.set(params.runId, marker);
    this.instrumentation.activeStreams.inc();
    marker.loopPromise = this.consumeLoop(marker, params).finally(() => {
      this.instrumentation.activeStreams.dec();
      this.active.delete(params.runId);
    });
  }

  async stop(runId: string): Promise<void> {
    const marker = this.active.get(runId);
    if (marker) marker.aborted = true;
  }

  isHealthy(): boolean {
    if (this.active.size === 0) return true;
    for (const [, marker] of this.active) {
      if (!marker.aborted && !marker.finalized && !marker.connected) return false;
    }
    return true;
  }

  private async finalizeRun(
    runId: string,
    marker: ActiveStream,
    status: 'completed' | 'failed' | 'cancelled',
    error?: unknown
  ): Promise<void> {
    if (marker.finalized) return;
    if (marker.finalizingPromise) {
      await marker.finalizingPromise;
      return;
    }
    const doFinalize = async () => {
      marker.finalized = true;
      marker.aborted = true;
      if (status === 'completed') {
        await this.runManager.markCompleted(runId);
      } else if (status === 'cancelled') {
        await this.runManager.markCancelled(runId);
      } else {
        await this.runManager.markFailed(runId, error ?? new Error('unknown failure'));
      }
      this.streamHub.complete(runId);
    };
    marker.finalizingPromise = doFinalize();
    await marker.finalizingPromise;
  }

  private backoffMs(retries: number): number {
    const base = this.config.streamBackoffBaseMs;
    const max = this.config.streamBackoffMaxMs;
    const exponential = Math.min(base * 2 ** retries, max);
    const jitter = Math.random() * exponential * 0.2;
    return exponential + jitter;
  }

  /**
   * Detect the runtime's "resume point was compacted" rejection — a gRPC
   * FAILED_PRECONDITION (code 9) raised on the StreamSession when we request an
   * `after_sequence` below the compacted base. Resubscribing from 0 after this
   * would double-ingest history (the CP has no message-id dedup), so callers
   * degrade to poll-only instead.
   */
  private isCompactedHistoryError(error: unknown): boolean {
    const code = (error as { code?: number })?.code;
    const message = error instanceof Error ? error.message : String(error);
    return code === 9 /* grpc FAILED_PRECONDITION */ || /compact/i.test(message);
  }

  /**
   * Emit a `session.stream.gap` control-plane event and flag the run's history
   * as incomplete (projection `historyGap: true`) when a compacted-history
   * resume gap is hit. Idempotent per run.
   */
  private async emitStreamGap(runId: string, runtimeSessionId: string, marker: ActiveStream): Promise<void> {
    if (marker.historyGap) return;
    marker.historyGap = true;
    this.instrumentation.streamResumeGapTotal.inc();
    this.logger.warn(
      `stream resume gap for run ${runId}: history before ordinal ${marker.envelopeOrdinal} was compacted; degrading to poll-only`
    );
    await this.eventService.emitControlPlaneEvents(runId, [
      {
        ts: new Date().toISOString(),
        type: 'session.stream.gap',
        source: { kind: 'macp-control-plane', name: 'stream-consumer' },
        subject: { kind: 'session', id: runtimeSessionId },
        data: {
          requestedAfter: marker.envelopeOrdinal,
          detail: 'session history before the resume point was compacted; some envelope-level events may be missing'
        }
      }
    ]);
  }

  private async consumeLoop(
    marker: ActiveStream,
    params: {
      runId: string;
      execution: RunDescriptor;
      runtimeKind: string;
      runtimeSessionId: string;
      subscriberId: string;
      sessionHandle?: RuntimeSessionHandle;
      pollOnly?: boolean;
    }
  ): Promise<void> {
    const provider = this.runtimeRegistry.get(params.runtimeKind);
    const context = {
      knownParticipants: new Set<string>(params.execution.session.participants.map((item) => item.id)),
      execution: params.execution,
      runtimeSessionId: params.runtimeSessionId
    };

    const maxRetries = this.config.streamMaxRetries;

    // Consume the per-session stream. On disconnect, resubscribe from the
    // persisted envelope ordinal (T7) instead of degrading straight to polling —
    // unless STREAM_RESUME_ENABLED is off, or the runtime reports the resume
    // point was compacted away (FAILED_PRECONDITION), in which case we emit a
    // `session.stream.gap` and fall through to poll-only (resubscribing from 0
    // would re-ingest history — the CP has no message-id dedup).
    let handle = params.sessionHandle;
    if (handle && !params.pollOnly) {
      let streamRetries = 0;
      while (!marker.aborted && !marker.finalized) {
        let gapDetected = false;
        try {
          for await (const raw of this.withIdleTimeout(handle.events, this.config.streamIdleTimeoutMs)) {
            if (marker.aborted) return;
            await this.handleRawEvent(params.runId, raw, context, params.runtimeSessionId, marker);
            if (marker.finalized) return;
            // Healthy delivery resets the reconnect budget.
            streamRetries = 0;
          }
        } catch (error) {
          marker.connected = false;
          gapDetected = this.isCompactedHistoryError(error);
          this.logger.warn(
            `stream error for run ${params.runId}: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        if (marker.finalized || marker.aborted) return;
        if (!this.config.streamResumeEnabled) break; // legacy poll-degrade behavior

        if (gapDetected) {
          await this.emitStreamGap(params.runId, params.runtimeSessionId, marker);
          break; // degrade to poll-only
        }

        streamRetries += 1;
        this.instrumentation.streamReconnectsTotal.inc();
        if (streamRetries > maxRetries) break; // exhausted → poll fallback

        await new Promise((resolve) => setTimeout(resolve, this.backoffMs(streamRetries)));
        if (marker.aborted || marker.finalized) return;

        // Resubscribe from the last delivered envelope ordinal (exclusive).
        try {
          handle = provider.subscribeSession({
            runId: params.runId,
            runtimeSessionId: params.runtimeSessionId,
            afterSequence: marker.envelopeOrdinal
          });
        } catch (error) {
          this.logger.warn(
            `resubscribe failed for run ${params.runId}: ${error instanceof Error ? error.message : String(error)}`
          );
          break; // fall through to poll fallback
        }
      }
    }

    // Polling fallback: poll getSession() until terminal state or max retries
    let retries = 0;
    while (!marker.aborted && !marker.finalized) {
      try {
        const snapshot = await provider.getSession({
          runId: params.runId,
          runtimeSessionId: params.runtimeSessionId,
          requesterId: params.subscriberId
        });
        await this.handleRawEvent(
          params.runId,
          { kind: 'session-snapshot', receivedAt: new Date().toISOString(), sessionSnapshot: snapshot },
          context,
          params.runtimeSessionId,
          marker
        );
        if (marker.finalized) return;

        if (snapshot.state === 'SESSION_STATE_RESOLVED') {
          await this.finalizeRun(params.runId, marker, 'completed');
          return;
        }
        if (snapshot.state === 'SESSION_STATE_EXPIRED') {
          await this.finalizeRun(params.runId, marker, 'failed', new Error('runtime session expired'));
          return;
        }
        // macp-proto 0.1.3: CANCELLED is its own terminal state. Without this,
        // an observed cancellation (when SessionDiscovery isn't running to mark
        // it first) would poll until retries exhaust and finalize as `failed`.
        if (snapshot.state === 'SESSION_STATE_CANCELLED') {
          await this.finalizeRun(params.runId, marker, 'cancelled');
          return;
        }
      } catch (pollError) {
        this.logger.warn(
          `getSession poll failed for run ${params.runId}: ${pollError instanceof Error ? pollError.message : String(pollError)}`
        );
      }

      retries += 1;
      this.instrumentation.streamReconnectsTotal.inc();
      if (retries > maxRetries) {
        await this.finalizeRun(
          params.runId,
          marker,
          'failed',
          new Error('polling exhausted without terminal session state')
        );
        return;
      }

      await this.eventService.emitControlPlaneEvents(params.runId, [
        {
          ts: new Date().toISOString(),
          type: 'session.stream.opened',
          source: { kind: 'macp-control-plane', name: 'stream-consumer' },
          subject: { kind: 'session', id: params.runtimeSessionId },
          data: { status: 'reconnecting', detail: 'polling getSession for terminal state' }
        }
      ]);
      await new Promise((resolve) => setTimeout(resolve, this.backoffMs(retries)));
    }
  }

  private async *withIdleTimeout<T>(iterable: AsyncIterable<T>, timeoutMs: number): AsyncIterable<T> {
    const iterator = iterable[Symbol.asyncIterator]();
    try {
      while (true) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            iterator.next(),
            new Promise<{ done: true; value: undefined }>((resolve) => {
              timer = setTimeout(() => resolve({ done: true, value: undefined }), timeoutMs);
              timer.unref();
            })
          ]);
          if (result.done) return;
          yield result.value;
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
    } finally {
      await iterator.return?.();
    }
  }

  private async handleRawEvent(
    runId: string,
    raw: RawRuntimeEvent,
    context: Parameters<EventNormalizerService['normalize']>[2],
    runtimeSessionId: string,
    marker: ActiveStream
  ) {
    return this.traceService.withRunSpan(
      runId,
      'stream.handle_raw_event',
      {
        'macp.raw_kind': raw.kind,
        'macp.message_type': raw.envelope?.messageType,
        'macp.session_id': runtimeSessionId
      },
      () => this.handleRawEventInner(runId, raw, context, runtimeSessionId, marker)
    );
  }

  private async handleRawEventInner(
    runId: string,
    raw: RawRuntimeEvent,
    context: Parameters<EventNormalizerService['normalize']>[2],
    runtimeSessionId: string,
    marker: ActiveStream
  ) {
    // Track stream connectivity
    if (raw.kind === 'stream-status' && raw.streamStatus?.status === 'opened') {
      marker.connected = true;
    }

    // Count accepted envelopes delivered on the per-session StreamSession — this
    // is the runtime's `after_sequence` ordinal used for stream resume (T7).
    // Only real envelopes count; snapshots / stream-status / inline errors and
    // ambient signals (handled by SignalConsumerService) must not increment it.
    if (raw.kind === 'stream-envelope' && raw.envelope) {
      marker.envelopeOrdinal += 1;
    }

    const canonical = this.normalizer.normalize(runId, raw, context);
    const emitted = await this.eventService.persistRawAndCanonical(runId, raw, canonical);

    for (const event of emitted) {
      if (event.seq <= marker.lastProcessedSeq) continue;
      marker.lastProcessedSeq = event.seq;
    }

    // Persist stream cursor + envelope ordinal for lossless reconnect / resume.
    if (marker.lastProcessedSeq > 0) {
      await this.runtimeSessionRepository.updateStreamCursor(runId, marker.lastProcessedSeq, marker.envelopeOrdinal);
    }

    const sessionStateChange = emitted.find((event) => event.type === 'session.state.changed');
    if (sessionStateChange && typeof sessionStateChange.data.state === 'string') {
      await this.runtimeSessionRepository.updateState(runId, sessionStateChange.data.state, new Date().toISOString());
      if (sessionStateChange.data.state === 'SESSION_STATE_RESOLVED') {
        await this.finalizeRun(runId, marker, 'completed');
        return;
      }
      if (sessionStateChange.data.state === 'SESSION_STATE_EXPIRED') {
        await this.finalizeRun(runId, marker, 'failed', new Error('runtime session expired'));
        return;
      }
      // macp-proto 0.1.3: CANCELLED terminal state → mark the run cancelled, not failed.
      if (sessionStateChange.data.state === 'SESSION_STATE_CANCELLED') {
        await this.finalizeRun(runId, marker, 'cancelled');
        return;
      }
    }
  }
}
