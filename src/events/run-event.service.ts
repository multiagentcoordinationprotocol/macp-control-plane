import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CanonicalEvent, RunStateProjection } from '../contracts/control-plane';
import { RawRuntimeEvent } from '../contracts/runtime';
import { DatabaseService } from '../db/database.service';
import { MetricsService } from '../metrics/metrics.service';
import { ProjectionService, PROJECTION_SCHEMA_VERSION } from '../projection/projection.service';
import { EventRepository } from '../storage/event.repository';
import { RunRepository } from '../storage/run.repository';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { RedactionService } from '../telemetry/redaction.service';
import { TraceService } from '../telemetry/trace.service';
import { StreamHubService } from './stream-hub.service';

const KEY_EVENT_SPAN_ANNOTATIONS: Record<
  string,
  Record<string, (e: CanonicalEvent) => string | number | boolean | undefined>
> = {
  'signal.emitted': {
    name: (e) => String((e.data.decodedPayload as Record<string, unknown> | undefined)?.signalType ?? e.type),
    sender: (e) => (e.data.sender as string | undefined) ?? ''
  },
  'signal.acknowledged': {
    signalId: (e) => String(e.subject?.id ?? ''),
    sender: (e) => (e.data.sender as string | undefined) ?? ''
  },
  'policy.denied': {
    errorCode: (e) => (e.data.errorCode as string | undefined) ?? ''
  },
  'decision.finalized': {
    action: (e) => String((e.data.decodedPayload as Record<string, unknown> | undefined)?.action ?? ''),
    outcome: (e) => {
      const p = e.data.decodedPayload as Record<string, unknown> | undefined;
      const v = p?.outcomePositive ?? p?.outcome_positive;
      return v === undefined ? undefined : Boolean(v);
    }
  }
};

@Injectable()
export class RunEventService {
  private readonly logger = new Logger(RunEventService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly runRepository: RunRepository,
    private readonly eventRepository: EventRepository,
    private readonly projectionService: ProjectionService,
    private readonly metricsService: MetricsService,
    private readonly streamHub: StreamHubService,
    private readonly traceService: TraceService,
    private readonly instrumentation: InstrumentationService,
    private readonly redaction: RedactionService
  ) {}

  async emitControlPlaneEvents(
    runId: string,
    partialEvents: Array<Omit<CanonicalEvent, 'id' | 'seq' | 'runId'>>
  ): Promise<CanonicalEvent[]> {
    if (partialEvents.length === 0) return [];

    // Stamp trace context from the active run span onto control-plane-emitted
    // events so they correlate with the waterfall (§6d).
    const runCtx = this.traceService.getRunTraceContext(runId);
    const stamped = runCtx
      ? partialEvents.map((event) =>
          event.trace ? event : { ...event, trace: { traceId: runCtx.traceId, spanId: runCtx.spanId } }
        )
      : partialEvents;

    const { events, projection } = await this.traceService.withRunSpan(
      runId,
      'run-event.emit',
      { 'macp.event_count': stamped.length },
      () =>
        this.database.db.transaction(async (tx) => {
          const startSeq = await this.runRepository.allocateSequence(runId, stamped.length);
          const prepared = stamped.map((event, index) => ({
            ...event,
            id: randomUUID(),
            runId,
            seq: startSeq + index,
            schemaVersion: PROJECTION_SCHEMA_VERSION
          }));
          await this.eventRepository.appendCanonical(prepared, tx);
          const proj = await this.projectionService.applyAndPersist(runId, prepared, tx);
          return { events: prepared, projection: proj };
        })
    );

    await this.runPostCommitSideEffects(runId, events, projection);
    return events;
  }

  async persistRawAndCanonical(
    runId: string,
    rawEvent: RawRuntimeEvent,
    canonicalEvents: CanonicalEvent[]
  ): Promise<CanonicalEvent[]> {
    const total = 1 + canonicalEvents.length;

    // Stamp trace context from the active run span onto any canonical event the
    // runtime didn't supply one for (§6d). This keeps the waterfall linked
    // even when the runtime's OTEL exporter isn't yet emitting `references[]`.
    const runCtx = this.traceService.getRunTraceContext(runId);
    const stamped = runCtx
      ? canonicalEvents.map((event) =>
          event.trace?.traceId ? event : { ...event, trace: { traceId: runCtx.traceId, spanId: runCtx.spanId } }
        )
      : canonicalEvents;

    const { normalized, projection } = await this.traceService.withRunSpan(
      runId,
      'run-event.persist',
      { 'macp.event_count': stamped.length, 'macp.raw_kind': rawEvent.kind },
      () =>
        this.database.db.transaction(async (tx) => {
          const startSeq = await this.runRepository.allocateSequence(runId, total);
          await this.eventRepository.appendRaw(runId, startSeq, rawEvent, tx);
          const prepared = stamped.map((event, index) => ({
            ...event,
            seq: startSeq + index + 1,
            id: event.id || randomUUID()
          }));
          await this.eventRepository.appendCanonical(prepared, tx);
          const proj = await this.projectionService.applyAndPersist(runId, prepared, tx);
          return { normalized: prepared, projection: proj };
        })
    );

    await this.runPostCommitSideEffects(runId, normalized, projection);
    return normalized;
  }

  /**
   * Runs the post-commit side effects (span annotations, metrics, SSE
   * publish) for a batch of events whose DB transaction has already
   * committed. None of these steps can undo that commit, so a failure here
   * must never propagate to the caller: `StreamConsumerService` treats a
   * rejected promise as "not yet durable" and re-ingests the same envelope on
   * the next reconnect, appending duplicate rows (see the comment on
   * `envelopeOrdinal` in `handleRawEventInner`). Every step — including
   * `recordSpanEvents`, which guards itself per-event internally — is caught
   * and logged independently so one failure (e.g. a metrics backend outage,
   * or one event's redaction throwing) doesn't suppress the others (e.g. SSE
   * publish still reaching connected clients, or span annotations for the
   * rest of the batch). `recordSpanEvents` was previously left entirely
   * unwrapped on the assumption it was pure in-memory annotation with no
   * fallible step; that stopped being true once it started running
   * attributes through `RedactionService.redact()` (reconcile,
   * ASSUMPTIONS.md P2 v0.8.0), which evaluates operator-supplied
   * `MACP_REDACT_PATTERNS` regexes against event data and so is no longer
   * guaranteed not to throw (or pathologically backtrack) for arbitrary input.
   */
  private async runPostCommitSideEffects(
    runId: string,
    events: CanonicalEvent[],
    projection: RunStateProjection
  ): Promise<void> {
    this.recordSpanEvents(runId, events);

    try {
      await this.metricsService.recordEvents(runId, events);
    } catch (error) {
      this.instrumentation.postCommitSideEffectFailuresTotal.inc({ step: 'metrics' });
      this.logger.error(
        `metrics recording failed for run ${runId} after commit (${events.length} event(s) already durable): ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }

    for (const event of events) {
      try {
        this.streamHub.publishEvent(event);
      } catch (error) {
        this.instrumentation.postCommitSideEffectFailuresTotal.inc({ step: 'publish_event' });
        this.logger.error(
          `SSE publish failed for run ${runId}, event ${event.id} after commit: ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    try {
      this.streamHub.publishSnapshot(runId, projection);
    } catch (error) {
      this.instrumentation.postCommitSideEffectFailuresTotal.inc({ step: 'publish_snapshot' });
      this.logger.error(
        `snapshot publish failed for run ${runId} after commit: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private recordSpanEvents(runId: string, events: CanonicalEvent[]): void {
    for (const event of events) {
      const ann = KEY_EVENT_SPAN_ANNOTATIONS[event.type];
      if (!ann) continue;
      // Per-event try/catch (mirrors the publishEvent loop below): a
      // redaction failure on one event's attrs must not drop span
      // annotations for the rest of the batch, the same way one bad
      // publishEvent doesn't block its siblings.
      try {
        const attrs: Record<string, string | number | boolean | undefined> = { seq: event.seq };
        for (const [k, fn] of Object.entries(ann)) {
          const v = fn(event);
          if (v !== undefined) attrs[k] = v;
        }
        this.traceService.addRunSpanEvent(runId, event.type, this.redaction.redact(attrs));
      } catch (error) {
        this.instrumentation.postCommitSideEffectFailuresTotal.inc({ step: 'span_events' });
        this.logger.error(
          `span event recording failed for run ${runId}, event ${event.id} after commit: ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
}
