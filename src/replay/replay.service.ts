import { Injectable } from '@nestjs/common';
import { Observable } from 'rxjs';
import {
  CanonicalEvent,
  ReplayRequest,
  RunStateProjection,
  normalizeEventSourceKind
} from '../contracts/control-plane';
import { AppConfigService } from '../config/app-config.service';
import { EventRepository } from '../storage/event.repository';
import { ProjectionService } from '../projection/projection.service';

@Injectable()
export class ReplayService {
  constructor(
    private readonly eventRepository: EventRepository,
    private readonly projectionService: ProjectionService,
    private readonly config: AppConfigService
  ) {}

  async describe(runId: string, request: ReplayRequest) {
    return {
      runId,
      mode: request.mode,
      speed: request.speed ?? 1,
      fromSeq: request.fromSeq,
      toSeq: request.toSeq,
      streamUrl: `/runs/${runId}/replay/stream?mode=${request.mode}&speed=${request.speed ?? 1}`,
      stateUrl: `/runs/${runId}/replay/state`
    };
  }

  stream(runId: string, request: ReplayRequest): Observable<{ data: CanonicalEvent; type: string }> {
    const batchSize = this.config.replayBatchSize;
    const maxDelay = this.config.replayMaxDelayMs;

    return new Observable((subscriber) => {
      void (async () => {
        const mode = request.mode ?? 'timed';
        const speed = request.speed ?? 1;
        let previousTimestamp = 0;
        let afterSeq = (request.fromSeq ?? 1) - 1;

        while (true) {
          const rows = await this.eventRepository.listCanonicalByRun(runId, afterSeq, batchSize);
          if (rows.length === 0) break;

          for (const row of rows) {
            if (request.toSeq !== undefined && row.seq > request.toSeq) {
              subscriber.complete();
              return;
            }

            const event = this.rowToCanonical(row);
            afterSeq = row.seq;

            if (mode === 'instant') {
              subscriber.next({ type: 'canonical_event', data: event });
              continue;
            }

            if (mode === 'step') {
              subscriber.next({ type: 'canonical_event', data: event });
              continue;
            }

            if (mode === 'timed') {
              const currentTimestamp = new Date(event.ts).getTime();
              if (previousTimestamp !== 0) {
                const delay = Math.max(0, Math.round((currentTimestamp - previousTimestamp) / speed));
                await new Promise((resolve) => setTimeout(resolve, Math.min(delay, maxDelay)));
              }
              previousTimestamp = currentTimestamp;
            }
            subscriber.next({ type: 'canonical_event', data: event });
          }

          if (rows.length < batchSize) break;
        }
        subscriber.complete();
      })().catch((error) => subscriber.error(error));
    });
  }

  async stateAt(runId: string, seq?: number): Promise<RunStateProjection> {
    const rows = await this.eventRepository.listCanonicalUpTo(runId, seq);
    const events = rows.map((row) => this.rowToCanonical(row));
    return this.projectionService.replayStateAt(runId, events);
  }

  private rowToCanonical(row: {
    id: string;
    runId: string;
    seq: number;
    ts: string;
    type: string;
    subjectKind: string | null;
    subjectId: string | null;
    sourceKind: string;
    sourceName: string;
    rawType: string | null;
    traceId: string | null;
    spanId: string | null;
    parentSpanId: string | null;
    data: Record<string, unknown>;
  }): CanonicalEvent {
    return {
      id: row.id,
      runId: row.runId,
      seq: row.seq,
      ts: row.ts,
      type: row.type,
      subject:
        row.subjectKind && row.subjectId
          ? {
              kind: row.subjectKind as CanonicalEvent['subject'] extends { kind: infer K } ? K : never,
              id: row.subjectId
            }
          : undefined,
      source: {
        kind: normalizeEventSourceKind(row.sourceKind),
        name: row.sourceName,
        rawType: row.rawType ?? undefined
      },
      trace: {
        traceId: row.traceId ?? undefined,
        spanId: row.spanId ?? undefined,
        parentSpanId: row.parentSpanId ?? undefined
      },
      data: row.data
    };
  }
}
