import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ExecutionRequest } from '../contracts/control-plane';
import { RawRuntimeEvent, RuntimeSessionHandle } from '../contracts/runtime';
import { AppConfigService } from '../config/app-config.service';
import { EventNormalizerService } from '../events/event-normalizer.service';
import { RunEventService } from '../events/run-event.service';
import { StreamHubService } from '../events/stream-hub.service';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { RuntimeProviderRegistry } from '../runtime/runtime-provider.registry';
import { RuntimeSessionRepository } from '../storage/runtime-session.repository';
import { RunManagerService } from './run-manager.service';

interface ActiveStream {
  aborted: boolean;
  finalized: boolean;
  connected: boolean;
  lastProcessedSeq: number;
  finalizingPromise?: Promise<void>;
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
    private readonly instrumentation: InstrumentationService
  ) {}

  async onModuleDestroy(): Promise<void> {
    for (const [runId, marker] of this.active) {
      marker.aborted = true;
      this.logger.log(`aborting stream for run ${runId} on shutdown`);
    }
  }

  async start(params: {
    runId: string;
    execution: ExecutionRequest;
    runtimeKind: string;
    runtimeSessionId: string;
    subscriberId: string;
    resumeFromSeq?: number;
    sessionHandle?: RuntimeSessionHandle;
    pollOnly?: boolean;
  }): Promise<void> {
    if (this.active.has(params.runId)) return;
    const marker: ActiveStream = {
      aborted: false,
      finalized: false,
      connected: false,
      lastProcessedSeq: params.resumeFromSeq ?? 0
    };
    this.active.set(params.runId, marker);
    this.instrumentation.activeStreams.inc();
    void this.consumeLoop(marker, params).finally(() => {
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
    status: 'completed' | 'failed',
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

  private async consumeLoop(
    marker: ActiveStream,
    params: {
      runId: string;
      execution: ExecutionRequest;
      runtimeKind: string;
      runtimeSessionId: string;
      subscriberId: string;
      sessionHandle?: RuntimeSessionHandle;
      pollOnly?: boolean;
    }
  ): Promise<void> {
    const provider = this.runtimeRegistry.get(params.runtimeKind);
    const context = {
      knownParticipants: new Set(params.execution.session.participants.map((item) => item.id)),
      execution: params.execution,
      runtimeSessionId: params.runtimeSessionId
    };

    const maxRetries = this.config.streamMaxRetries;

    // If we have a session handle and not poll-only, consume the stream first
    if (params.sessionHandle && !params.pollOnly) {
      try {
        for await (const raw of this.withIdleTimeout(params.sessionHandle.events, this.config.streamIdleTimeoutMs)) {
          if (marker.aborted) return;
          await this.handleRawEvent(params.runId, raw, context, params.runtimeSessionId, marker);
          if (marker.finalized) return;
        }
      } catch (error) {
        marker.connected = false;
        this.logger.warn(`stream error for run ${params.runId}: ${error instanceof Error ? error.message : String(error)}`);
      }

      // Stream ended — check if already finalized
      if (marker.finalized || marker.aborted) return;
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
      } catch (pollError) {
        this.logger.warn(
          `getSession poll failed for run ${params.runId}: ${pollError instanceof Error ? pollError.message : String(pollError)}`
        );
      }

      retries += 1;
      this.instrumentation.streamReconnectsTotal.inc();
      if (retries > maxRetries) {
        await this.finalizeRun(params.runId, marker, 'failed', new Error('polling exhausted without terminal session state'));
        return;
      }

      await this.eventService.emitControlPlaneEvents(params.runId, [
        {
          ts: new Date().toISOString(),
          type: 'session.stream.opened',
          source: { kind: 'control-plane', name: 'stream-consumer' },
          subject: { kind: 'session', id: params.runtimeSessionId },
          data: { status: 'reconnecting', detail: 'polling getSession for terminal state' }
        }
      ]);
      await new Promise((resolve) => setTimeout(resolve, this.backoffMs(retries)));
    }
  }

  private async *withIdleTimeout<T>(
    iterable: AsyncIterable<T>,
    timeoutMs: number
  ): AsyncIterable<T> {
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
    // Track stream connectivity
    if (raw.kind === 'stream-status' && raw.streamStatus?.status === 'opened') {
      marker.connected = true;
    }

    const canonical = this.normalizer.normalize(runId, raw, context);
    const emitted = await this.eventService.persistRawAndCanonical(runId, raw, canonical);

    for (const event of emitted) {
      if (event.seq <= marker.lastProcessedSeq) continue;
      marker.lastProcessedSeq = event.seq;
    }

    // Persist stream cursor for lossless reconnect
    if (marker.lastProcessedSeq > 0) {
      await this.runtimeSessionRepository.updateStreamCursor(runId, marker.lastProcessedSeq);
    }

    const sessionStateChange = emitted.find((event) => event.type === 'session.state.changed');
    if (sessionStateChange && typeof sessionStateChange.data.state === 'string') {
      await this.runtimeSessionRepository.updateState(
        runId,
        sessionStateChange.data.state,
        new Date().toISOString()
      );
      if (sessionStateChange.data.state === 'SESSION_STATE_RESOLVED') {
        await this.finalizeRun(runId, marker, 'completed');
        return;
      }
      if (sessionStateChange.data.state === 'SESSION_STATE_EXPIRED') {
        await this.finalizeRun(runId, marker, 'failed', new Error('runtime session expired'));
        return;
      }
    }

  }
}
