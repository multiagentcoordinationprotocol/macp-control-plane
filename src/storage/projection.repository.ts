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

  /**
   * @param force When true, bypass the optimistic `version < ${version}` guard
   * and overwrite unconditionally. Used by authoritative full rebuilds, which
   * must win even when the stored projection already carries the same (or a
   * higher) version — e.g. repairing a stale terminal-run projection whose
   * decision.finalized was dropped by a cross-stream write race.
   */
  async upsert(
    runId: string,
    projection: RunStateProjection,
    version: number,
    schemaVersion?: number,
    tx?: Tx,
    force = false
  ) {
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
      policy: projection.policy as unknown as Record<string, unknown>,
      updatedAt: new Date().toISOString()
    };

    await db
      .insert(runProjections)
      .values({ runId, version, ...data })
      .onConflictDoUpdate({
        target: runProjections.runId,
        set: { version, ...data },
        // Normal writes are monotonic (a higher-version write wins, so an
        // out-of-order lower-version write can't clobber). Forced rebuilds skip
        // the guard so an authoritative replay always lands.
        ...(force ? {} : { setWhere: sql`${runProjections.version} < ${version}` })
      });
  }
}
