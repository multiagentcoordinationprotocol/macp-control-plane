import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { RunStateProjection } from '../contracts/control-plane';
import { DatabaseService } from '../db/database.service';
import * as schemaModule from '../db/schema';
import { runProjections } from '../db/schema';

type Tx = NodePgDatabase<typeof schemaModule>;

@Injectable()
export class ProjectionRepository {
  constructor(private readonly database: DatabaseService) {}

  async get(runId: string) {
    const rows = await this.database.db.select().from(runProjections).where(eq(runProjections.runId, runId)).limit(1);
    return rows[0] ?? null;
  }

  async upsert(runId: string, projection: RunStateProjection, version: number, schemaVersion?: number, tx?: Tx) {
    const db = tx ?? this.database.db;
    const data = {
      schemaVersion: schemaVersion ?? 0,
      runSummary: projection.run as unknown as Record<string, unknown>,
      participants: projection.participants as unknown as Record<string, unknown>[],
      graph: projection.graph as unknown as Record<string, unknown>,
      decision: projection.decision as unknown as Record<string, unknown>,
      signals: projection.signals as unknown as Record<string, unknown>,
      timeline: projection.timeline as unknown as Record<string, unknown>,
      traceSummary: projection.trace as unknown as Record<string, unknown>,
      progress: projection.progress as unknown as Record<string, unknown>,
      updatedAt: new Date().toISOString()
    };

    await db
      .insert(runProjections)
      .values({ runId, version, ...data })
      .onConflictDoUpdate({
        target: runProjections.runId,
        set: { version, ...data },
        setWhere: sql`${runProjections.version} < ${version}`
      });
  }
}
