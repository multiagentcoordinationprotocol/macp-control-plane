import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, gt, gte, inArray, lt, lte, sql, SQL } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomUUID } from 'node:crypto';
import { CanonicalEvent } from '../contracts/control-plane';
import { RawRuntimeEvent } from '../contracts/runtime';
import { DatabaseService } from '../db/database.service';
import * as schema from '../db/schema';
import { runEventsCanonical, runEventsRaw, runs } from '../db/schema';

export interface CanonicalEventFilter {
  runId?: string;
  afterSeq?: number;
  afterTs?: string;
  beforeTs?: string;
  types?: string[];
  scenarioRef?: string;
  limit?: number;
}

type Tx = NodePgDatabase<typeof schema>;

@Injectable()
export class EventRepository {
  constructor(private readonly database: DatabaseService) {}

  async appendRaw(runId: string, seq: number, raw: RawRuntimeEvent, tx?: Tx) {
    const db = tx ?? this.database.db;
    await db
      .insert(runEventsRaw)
      .values({
        id: randomUUID(),
        runId,
        seq,
        ts: raw.receivedAt,
        kind: raw.kind,
        sourceName: 'rust-runtime',
        payload: this.serializeRaw(raw)
      })
      .onConflictDoNothing();
  }

  async appendCanonical(events: CanonicalEvent[], tx?: Tx) {
    if (events.length === 0) return;
    const db = tx ?? this.database.db;
    await db
      .insert(runEventsCanonical)
      .values(
        events.map((event) => ({
          id: event.id,
          runId: event.runId,
          seq: event.seq,
          ts: event.ts,
          type: event.type,
          subjectKind: event.subject?.kind,
          subjectId: event.subject?.id,
          sourceKind: event.source.kind,
          sourceName: event.source.name,
          rawType: event.source.rawType,
          traceId: event.trace?.traceId,
          spanId: event.trace?.spanId,
          parentSpanId: event.trace?.parentSpanId,
          data: event.data,
          schemaVersion: event.schemaVersion ?? 3
        }))
      )
      .onConflictDoNothing();
  }

  async listCanonicalByRun(runId: string, afterSeq = 0, limit = 200) {
    return this.database.db
      .select()
      .from(runEventsCanonical)
      .where(and(eq(runEventsCanonical.runId, runId), gt(runEventsCanonical.seq, afterSeq)))
      .orderBy(asc(runEventsCanonical.seq))
      .limit(limit);
  }

  /**
   * Filtered query over canonical events — used by the per-run endpoint with time bounds (§4.2)
   * and the cross-run GET /events endpoint (§4.1).
   */
  async listCanonicalFiltered(
    filter: CanonicalEventFilter
  ): Promise<{ data: (typeof runEventsCanonical.$inferSelect)[]; total: number }> {
    const conditions = this.buildCanonicalWhere(filter);
    const limit = filter.limit ?? 200;
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // For scenarioRef we must JOIN runs; otherwise simple SELECT
    if (filter.scenarioRef) {
      const scenarioExact = filter.scenarioRef;
      const scenarioLike = `%${filter.scenarioRef}%`;
      const baseWhere = conditions.length > 0 ? and(...conditions) : sql`TRUE`;
      const composed = and(
        baseWhere,
        sql`(${runs.sourceRef} = ${scenarioExact} OR ${runs.metadata}->>'scenarioRef' ILIKE ${scenarioLike})`
      );
      const [data, totalResult] = await Promise.all([
        this.database.db
          .select({
            id: runEventsCanonical.id,
            runId: runEventsCanonical.runId,
            seq: runEventsCanonical.seq,
            ts: runEventsCanonical.ts,
            type: runEventsCanonical.type,
            subjectKind: runEventsCanonical.subjectKind,
            subjectId: runEventsCanonical.subjectId,
            sourceKind: runEventsCanonical.sourceKind,
            sourceName: runEventsCanonical.sourceName,
            rawType: runEventsCanonical.rawType,
            traceId: runEventsCanonical.traceId,
            spanId: runEventsCanonical.spanId,
            parentSpanId: runEventsCanonical.parentSpanId,
            data: runEventsCanonical.data,
            schemaVersion: runEventsCanonical.schemaVersion
          })
          .from(runEventsCanonical)
          .innerJoin(runs, eq(runs.id, runEventsCanonical.runId))
          .where(composed)
          .orderBy(asc(runEventsCanonical.ts), asc(runEventsCanonical.seq))
          .limit(limit),
        this.database.db
          .select({ value: count() })
          .from(runEventsCanonical)
          .innerJoin(runs, eq(runs.id, runEventsCanonical.runId))
          .where(composed)
      ]);
      return { data: data as (typeof runEventsCanonical.$inferSelect)[], total: Number(totalResult[0]?.value ?? 0) };
    }

    const [data, totalResult] = await Promise.all([
      this.database.db
        .select()
        .from(runEventsCanonical)
        .where(whereClause)
        .orderBy(asc(runEventsCanonical.ts), asc(runEventsCanonical.seq))
        .limit(limit),
      this.database.db.select({ value: count() }).from(runEventsCanonical).where(whereClause)
    ]);
    return { data, total: Number(totalResult[0]?.value ?? 0) };
  }

  private buildCanonicalWhere(filter: CanonicalEventFilter): SQL[] {
    const conditions: SQL[] = [];
    if (filter.runId) conditions.push(eq(runEventsCanonical.runId, filter.runId));
    if (filter.afterSeq !== undefined && filter.afterSeq > 0) {
      conditions.push(gt(runEventsCanonical.seq, filter.afterSeq));
    }
    if (filter.afterTs) conditions.push(gte(runEventsCanonical.ts, filter.afterTs));
    if (filter.beforeTs) conditions.push(lt(runEventsCanonical.ts, filter.beforeTs));
    if (filter.types && filter.types.length > 0) {
      conditions.push(inArray(runEventsCanonical.type, filter.types));
    }
    return conditions;
  }

  async listCanonicalRange(runId: string, afterSeq: number, toSeq: number, limit = 500) {
    return this.database.db
      .select()
      .from(runEventsCanonical)
      .where(
        and(
          eq(runEventsCanonical.runId, runId),
          gt(runEventsCanonical.seq, afterSeq),
          lte(runEventsCanonical.seq, toSeq)
        )
      )
      .orderBy(asc(runEventsCanonical.seq))
      .limit(limit);
  }

  async listRawByRun(runId: string, afterSeq = 0, limit = 1000) {
    return this.database.db
      .select()
      .from(runEventsRaw)
      .where(and(eq(runEventsRaw.runId, runId), gt(runEventsRaw.seq, afterSeq)))
      .orderBy(asc(runEventsRaw.seq))
      .limit(limit);
  }

  async *streamCanonicalByRun(
    runId: string,
    afterSeq = 0,
    batchSize = 500
  ): AsyncGenerator<typeof runEventsCanonical.$inferSelect> {
    let cursor = afterSeq;
    while (true) {
      const batch = await this.database.db
        .select()
        .from(runEventsCanonical)
        .where(and(eq(runEventsCanonical.runId, runId), gt(runEventsCanonical.seq, cursor)))
        .orderBy(asc(runEventsCanonical.seq))
        .limit(batchSize);
      if (batch.length === 0) return;
      for (const event of batch) {
        yield event;
      }
      cursor = batch[batch.length - 1].seq;
      if (batch.length < batchSize) return;
    }
  }

  async listCanonicalUpTo(runId: string, seq?: number) {
    const where =
      seq === undefined
        ? eq(runEventsCanonical.runId, runId)
        : and(eq(runEventsCanonical.runId, runId), lte(runEventsCanonical.seq, seq));
    return this.database.db.select().from(runEventsCanonical).where(where).orderBy(asc(runEventsCanonical.seq));
  }

  private serializeRaw(raw: RawRuntimeEvent): Record<string, unknown> {
    if (raw.envelope) {
      return {
        ...raw,
        envelope: {
          ...raw.envelope,
          payloadBase64: raw.envelope.payload.toString('base64')
        }
      };
    }
    return raw as unknown as Record<string, unknown>;
  }
}
