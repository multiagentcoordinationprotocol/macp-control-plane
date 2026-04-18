import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
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

  async updateStreamCursor(runId: string, cursor: number) {
    await this.database.db
      .update(runtimeSessions)
      .set({ lastStreamCursor: cursor, updatedAt: new Date().toISOString() })
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
