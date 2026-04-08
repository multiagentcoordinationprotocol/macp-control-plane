import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql, SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { RunStatus } from '../contracts/control-plane';
import { DatabaseService } from '../db/database.service';
import { runs } from '../db/schema';

const VALID_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  queued: ['starting', 'failed', 'cancelled'],
  starting: ['binding_session', 'failed', 'cancelled'],
  binding_session: ['running', 'failed', 'cancelled'],
  running: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: []
};

export interface NewRunRecord {
  id?: string;
  status: RunStatus;
  mode: string;
  runtimeKind: string;
  runtimeVersion?: string;
  idempotencyKey?: string;
  tags?: string[];
  sourceKind?: string;
  sourceRef?: string;
  metadata?: Record<string, unknown>;
  traceId?: string;
}

@Injectable()
export class RunRepository {
  constructor(private readonly database: DatabaseService) {}

  async create(input: NewRunRecord) {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    await this.database.db.insert(runs).values({
      id,
      status: input.status,
      mode: input.mode,
      runtimeKind: input.runtimeKind,
      runtimeVersion: input.runtimeVersion,
      idempotencyKey: input.idempotencyKey,
      tags: input.tags ?? [],
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef,
      metadata: input.metadata ?? {},
      traceId: input.traceId,
      createdAt: now,
      updatedAt: now
    });
    return this.findByIdOrThrow(id);
  }

  async findById(id: string) {
    const rows = await this.database.db.select().from(runs).where(eq(runs.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async findByIdOrThrow(id: string) {
    const row = await this.findById(id);
    if (!row) throw new NotFoundException(`run ${id} not found`);
    return row;
  }

  async findByIdempotencyKey(idempotencyKey: string) {
    const rows = await this.database.db
      .select()
      .from(runs)
      .where(eq(runs.idempotencyKey, idempotencyKey))
      .limit(1);
    return rows[0] ?? null;
  }

  async update(id: string, patch: Partial<typeof runs.$inferInsert>) {
    await this.database.db
      .update(runs)
      .set({ ...patch, updatedAt: new Date().toISOString() })
      .where(eq(runs.id, id));
    return this.findByIdOrThrow(id);
  }

  async allocateSequence(runId: string, count = 1): Promise<number> {
    const result = await this.database.db.execute(sql`
      UPDATE runs
      SET last_event_seq = last_event_seq + ${count},
          updated_at = now()
      WHERE id = ${runId}
      RETURNING last_event_seq
    `);
    const row = result.rows[0] as { last_event_seq: number } | undefined;
    if (!row) throw new Error(`run ${runId} not found while allocating sequence`);
    return Number(row.last_event_seq) - count + 1;
  }

  private async transitionTo(
    id: string,
    targetStatus: RunStatus,
    patch: Partial<typeof runs.$inferInsert>
  ) {
    const validFrom = Object.entries(VALID_TRANSITIONS)
      .filter(([, targets]) => targets.includes(targetStatus))
      .map(([from]) => from);

    if (validFrom.length === 0) {
      throw new ConflictException(`no valid transitions to '${targetStatus}'`);
    }

    const result = await this.database.db
      .update(runs)
      .set({ ...patch, status: targetStatus, updatedAt: new Date().toISOString() })
      .where(and(eq(runs.id, id), inArray(runs.status, validFrom)))
      .returning();

    if (result.length === 0) {
      const current = await this.findById(id);
      if (!current) throw new Error(`run ${id} not found`);
      if (current.status === targetStatus) return current;
      throw new ConflictException(
        `cannot transition run ${id} from '${current.status}' to '${targetStatus}'`
      );
    }
    return result[0];
  }

  async markStarted(id: string) {
    return this.transitionTo(id, 'starting', {
      startedAt: new Date().toISOString()
    });
  }

  async markBindingSession(id: string, runtimeSessionId: string) {
    return this.transitionTo(id, 'binding_session', {
      runtimeSessionId
    });
  }

  async markRunning(id: string, runtimeSessionId?: string) {
    return this.transitionTo(id, 'running', {
      runtimeSessionId
    });
  }

  async markCompleted(id: string, runtimeSessionId?: string) {
    return this.transitionTo(id, 'completed', {
      runtimeSessionId,
      endedAt: new Date().toISOString()
    });
  }

  async markCancelled(id: string) {
    return this.transitionTo(id, 'cancelled', {
      endedAt: new Date().toISOString()
    });
  }

  async markFailed(id: string, errorCode?: string, errorMessage?: string) {
    return this.transitionTo(id, 'failed', {
      errorCode,
      errorMessage,
      endedAt: new Date().toISOString()
    });
  }

  async listActiveRuns() {
    return this.database.db
      .select()
      .from(runs)
      .where(and(sql`${runs.status} in ('starting', 'binding_session', 'running')`));
  }

  async list(filters: {
    status?: RunStatus;
    tags?: string[];
    createdAfter?: string;
    createdBefore?: string;
    limit?: number;
    offset?: number;
    sortBy?: 'createdAt' | 'updatedAt';
    sortOrder?: 'asc' | 'desc';
    includeSandbox?: boolean;
    includeArchived?: boolean;
    environment?: string;
    scenarioRef?: string;
    search?: string;
  }) {
    const conditions = this.buildListConditions(filters);

    const sortCol = filters.sortBy === 'updatedAt' ? runs.updatedAt : runs.createdAt;
    const orderFn = filters.sortOrder === 'asc' ? asc : desc;

    const query = this.database.db
      .select()
      .from(runs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(orderFn(sortCol))
      .limit(filters.limit ?? 50)
      .offset(filters.offset ?? 0);

    return query;
  }

  async listCount(filters: {
    status?: RunStatus;
    tags?: string[];
    createdAfter?: string;
    createdBefore?: string;
    includeSandbox?: boolean;
    includeArchived?: boolean;
    environment?: string;
    scenarioRef?: string;
    search?: string;
  }): Promise<number> {
    const conditions = this.buildListConditions(filters);
    const result = await this.database.db
      .select({ count: sql<number>`count(*)::int` })
      .from(runs)
      .where(conditions.length > 0 ? and(...conditions) : undefined);
    return result[0]?.count ?? 0;
  }

  private buildListConditions(filters: {
    status?: RunStatus;
    tags?: string[];
    createdAfter?: string;
    createdBefore?: string;
    includeSandbox?: boolean;
    includeArchived?: boolean;
    environment?: string;
    scenarioRef?: string;
    search?: string;
  }): SQL[] {
    const conditions: SQL[] = [];
    if (filters.status) conditions.push(eq(runs.status, filters.status));
    if (filters.tags && filters.tags.length > 0) {
      conditions.push(sql`${runs.tags} @> ${JSON.stringify(filters.tags)}::jsonb`);
    }
    if (filters.createdAfter) conditions.push(gt(runs.createdAt, filters.createdAfter));
    if (filters.createdBefore) conditions.push(lt(runs.createdAt, filters.createdBefore));
    if (!filters.includeSandbox) conditions.push(sql`${runs.mode} != 'sandbox'`);
    if (!filters.includeArchived) {
      conditions.push(isNull(runs.archivedAt));
    }
    if (filters.environment) {
      conditions.push(sql`${runs.metadata}->>'environment' = ${filters.environment}`);
    }
    if (filters.scenarioRef) {
      conditions.push(sql`${runs.metadata}->>'scenarioRef' ILIKE ${'%' + filters.scenarioRef + '%'}`);
    }
    if (filters.search) {
      const term = `%${filters.search}%`;
      conditions.push(sql`(
        ${runs.id}::text ILIKE ${term}
        OR ${runs.metadata}->>'scenarioRef' ILIKE ${term}
        OR ${runs.metadata}->>'environment' ILIKE ${term}
        OR ${runs.tags}::text ILIKE ${term}
      )`);
    }
    return conditions;
  }

  async delete(id: string): Promise<void> {
    await this.database.db.delete(runs).where(eq(runs.id, id));
  }

  async addTag(id: string, tag: string): Promise<typeof runs.$inferSelect> {
    await this.database.db.execute(sql`
      UPDATE runs
      SET tags = tags || ${JSON.stringify([tag])}::jsonb,
          updated_at = now()
      WHERE id = ${id}
      AND NOT (tags @> ${JSON.stringify([tag])}::jsonb)
    `);
    return this.findByIdOrThrow(id);
  }

  async archive(id: string): Promise<typeof runs.$inferSelect> {
    await this.database.db.execute(sql`
      UPDATE runs
      SET tags = CASE WHEN NOT (tags @> '["archived"]'::jsonb) THEN tags || '["archived"]'::jsonb ELSE tags END,
          archived_at = COALESCE(archived_at, now()),
          updated_at = now()
      WHERE id = ${id}
    `);
    return this.findByIdOrThrow(id);
  }
}
