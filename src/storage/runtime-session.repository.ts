import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { runtimeSessions } from '../db/schema';

@Injectable()
export class RuntimeSessionRepository {
  constructor(private readonly database: DatabaseService) {}

  async upsert(input: typeof runtimeSessions.$inferInsert) {
    await this.database.db
      .insert(runtimeSessions)
      .values(input)
      .onConflictDoUpdate({
        target: runtimeSessions.runId,
        set: {
          runtimeKind: input.runtimeKind,
          runtimeSessionId: input.runtimeSessionId,
          modeName: input.modeName,
          modeVersion: input.modeVersion,
          configurationVersion: input.configurationVersion,
          policyVersion: input.policyVersion,
          initiatorParticipantId: input.initiatorParticipantId,
          sessionState: input.sessionState,
          expiresAt: input.expiresAt,
          lastSeenAt: input.lastSeenAt,
          metadata: input.metadata,
          updatedAt: new Date().toISOString()
        }
      });
    return this.findByRunId(input.runId);
  }

  async findByRunId(runId: string) {
    const rows = await this.database.db.select().from(runtimeSessions).where(eq(runtimeSessions.runId, runId)).limit(1);
    return rows[0] ?? null;
  }

  async updateState(runId: string, sessionState: string, lastSeenAt?: string) {
    await this.database.db
      .update(runtimeSessions)
      .set({ sessionState, lastSeenAt: lastSeenAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() })
      .where(eq(runtimeSessions.runId, runId));
    return this.findByRunId(runId);
  }

  async updateStreamCursor(runId: string, cursor: number, envelopeOrdinal?: number) {
    // `cursor` is the CP-side canonical event seq; `envelopeOrdinal` (optional)
    // is the runtime's 1-based accepted-envelope ordinal used for stream resume
    // (T7). Written together so a single row update advances both markers.
    //
    // Both values are monotonic per run by their own semantics, so the write is
    // a GREATEST floor rather than a blind `.set()`: a floor is a no-op on the
    // happy path but makes an entire class of clobber bugs (unseeded markers,
    // future caller mistakes, races between concurrent writers) structurally
    // impossible. This is a single UPDATE — no read-then-write, so no race
    // window between reading the current value and writing the new one.
    await this.database.db
      .update(runtimeSessions)
      .set({
        lastStreamCursor: sql`GREATEST(COALESCE(${runtimeSessions.lastStreamCursor}, 0), ${cursor})`,
        ...(envelopeOrdinal !== undefined
          ? { lastEnvelopeOrdinal: sql`GREATEST(${runtimeSessions.lastEnvelopeOrdinal}, ${envelopeOrdinal})` }
          : {}),
        updatedAt: new Date().toISOString()
      })
      .where(eq(runtimeSessions.runId, runId));
  }

  async updateStreamConnected(runId: string) {
    await this.database.db
      .update(runtimeSessions)
      .set({ streamConnectedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      .where(eq(runtimeSessions.runId, runId));
  }

  async updateStreamDisconnected(runId: string) {
    await this.database.db
      .update(runtimeSessions)
      .set({ streamDisconnectedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      .where(eq(runtimeSessions.runId, runId));
  }
}
