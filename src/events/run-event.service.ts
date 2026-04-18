import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CanonicalEvent } from '../contracts/control-plane';
import { RawRuntimeEvent } from '../contracts/runtime';
import { DatabaseService } from '../db/database.service';
import { MetricsService } from '../metrics/metrics.service';
import { ProjectionService, PROJECTION_SCHEMA_VERSION } from '../projection/projection.service';
import { EventRepository } from '../storage/event.repository';
import { RunRepository } from '../storage/run.repository';
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
  constructor(
    private readonly database: DatabaseService,
    private readonly runRepository: RunRepository,
    private readonly eventRepository: EventRepository,
    private readonly projectionService: ProjectionService,
    private readonly metricsService: MetricsService,
    private readonly streamHub: StreamHubService,
    private readonly traceService: TraceService
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

    this.recordSpanEvents(runId, events);
    await this.metricsService.recordEvents(runId, events);
    events.forEach((event) => this.streamHub.publishEvent(event));
    this.streamHub.publishSnapshot(runId, projection);
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

    this.recordSpanEvents(runId, normalized);
    await this.metricsService.recordEvents(runId, normalized);
    normalized.forEach((event) => this.streamHub.publishEvent(event));
    this.streamHub.publishSnapshot(runId, projection);
    return normalized;
  }

  private recordSpanEvents(runId: string, events: CanonicalEvent[]): void {
    for (const event of events) {
      const ann = KEY_EVENT_SPAN_ANNOTATIONS[event.type];
      if (!ann) continue;
      const attrs: Record<string, string | number | boolean | undefined> = { seq: event.seq };
      for (const [k, fn] of Object.entries(ann)) {
        const v = fn(event);
        if (v !== undefined) attrs[k] = v;
      }
      this.traceService.addRunSpanEvent(runId, event.type, attrs);
    }
  }
}
