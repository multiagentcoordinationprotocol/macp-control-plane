import { Injectable, Logger } from '@nestjs/common';
import { sql, SQL } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { RunRepository } from '../storage/run.repository';
import { RuntimeProviderRegistry } from '../runtime/runtime-provider.registry';

export interface DashboardOverviewOptions {
  window?: '1h' | '6h' | '24h' | '7d' | '30d';
  from?: string;
  to?: string;
  scenarioRef?: string;
  environment?: string;
}

interface RunFilters {
  scenarioRef?: string;
  environment?: string;
}

function resolveWindow(opts: DashboardOverviewOptions): {
  cutoffSql: SQL;
  bucket: 'minute' | 'hour' | 'day';
} {
  if (opts.from) {
    const cutoffSql = sql`${opts.from}::timestamptz`;
    const bucket = bucketFromRange(new Date(opts.from), opts.to ? new Date(opts.to) : new Date());
    return { cutoffSql, bucket };
  }
  const window = opts.window ?? '24h';
  const interval =
    window === '1h' ? '1 hour'
      : window === '6h' ? '6 hours'
      : window === '24h' ? '24 hours'
      : window === '7d' ? '7 days'
      : '30 days';
  const bucket: 'minute' | 'hour' | 'day' =
    window === '1h' || window === '6h' ? 'minute'
      : window === '24h' ? 'hour'
      : 'day';
  return {
    cutoffSql: sql`now() - interval '${sql.raw(interval)}'`,
    bucket
  };
}

function bucketFromRange(from: Date, to: Date): 'minute' | 'hour' | 'day' {
  const diffMs = to.getTime() - from.getTime();
  const hours = diffMs / (60 * 60 * 1000);
  if (hours <= 6) return 'minute';
  if (hours <= 48) return 'hour';
  return 'day';
}

function buildRunFilters(opts: DashboardOverviewOptions): RunFilters {
  return { scenarioRef: opts.scenarioRef, environment: opts.environment };
}

function runsWhereClause(filters: RunFilters): SQL {
  const parts: SQL[] = [];
  if (filters.scenarioRef) {
    const exact = filters.scenarioRef;
    const like = `%${filters.scenarioRef}%`;
    parts.push(sql`(r.source_ref = ${exact} OR r.metadata->>'scenarioRef' ILIKE ${like})`);
  }
  if (filters.environment) parts.push(sql`r.metadata->>'environment' = ${filters.environment}`);
  if (parts.length === 0) return sql`TRUE`;
  return sql.join(parts, sql` AND `);
}

function toSeries(
  rows: Record<string, unknown>[],
  labelKey: string,
  dataKey: string
): { labels: string[]; data: number[] } {
  return {
    labels: rows.map((r) => String(r[labelKey])),
    data: rows.map((r) => Number(r[dataKey] ?? 0))
  };
}

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly runRepository: RunRepository,
    private readonly runtimeRegistry: RuntimeProviderRegistry
  ) {}

  async getOverview(opts: DashboardOverviewOptions = {}) {
    const { cutoffSql, bucket } = resolveWindow(opts);
    const filters = buildRunFilters(opts);

    const [
      kpis,
      volumeSeries,
      signalSeries,
      errorSeries,
      latencyStats,
      throughputSeries,
      queueDepthSeries,
      latencyPercentileSeries,
      costSeries,
      successRateSeries,
      decisionOutcomeSeries,
      perScenarioSeries,
      recentRuns,
      runtimeHealth
    ] = await Promise.all([
      this.getKpis(cutoffSql, filters),
      this.getRunVolume(cutoffSql, bucket, filters),
      this.getSignalVolume(cutoffSql, bucket, filters),
      this.getErrorClasses(cutoffSql, filters),
      this.getLatencyStats(cutoffSql, bucket, filters),
      this.getThroughput(cutoffSql, bucket, filters),
      this.getQueueDepth(cutoffSql, bucket, filters),
      this.getLatencyPercentiles(cutoffSql, bucket, filters),
      this.getCostSeries(cutoffSql, bucket, filters),
      this.getSuccessRate(cutoffSql, bucket, filters),
      this.getDecisionOutcome(cutoffSql, bucket, filters),
      this.getPerScenarioVolume(cutoffSql, filters),
      this.getRecentRuns(filters),
      this.getRuntimeHealth()
    ]);

    return {
      kpis: {
        ...kpis,
        avgDurationMs: latencyStats.avgDurationMs
      },
      recentRuns,
      runtimeHealth,
      charts: {
        runVolume: volumeSeries,
        latency: latencyStats.series,
        signalVolume: signalSeries,
        errorClasses: errorSeries,
        throughput: throughputSeries,
        queueDepth: queueDepthSeries,
        latencyP50: latencyPercentileSeries.p50,
        latencyP95: latencyPercentileSeries.p95,
        latencyP99: latencyPercentileSeries.p99,
        cost: costSeries,
        successRate: successRateSeries,
        decisionOutcome: decisionOutcomeSeries,
        perScenario: perScenarioSeries
      }
    };
  }

  private async getKpis(cutoff: SQL, filters: RunFilters) {
    const runWhere = runsWhereClause(filters);
    const [runResult, signalResult, tokenResult] = await Promise.all([
      this.database.db.execute(sql`
        SELECT
          count(*)::int AS "totalRuns",
          count(*) FILTER (WHERE status IN ('queued','starting','binding_session','running'))::int AS "activeRuns",
          count(*) FILTER (WHERE status = 'completed')::int AS "completedRuns",
          count(*) FILTER (WHERE status = 'failed')::int AS "failedRuns",
          count(*) FILTER (WHERE status = 'cancelled')::int AS "cancelledRuns"
        FROM runs r
        WHERE r.created_at >= ${cutoff}
          AND ${runWhere}
      `),
      this.database.db.execute(sql`
        SELECT count(*)::int AS "totalSignals"
        FROM run_events_canonical e
        JOIN runs r ON r.id = e.run_id
        WHERE e.type = 'signal.emitted'
          AND e.ts::timestamptz >= ${cutoff}
          AND ${runWhere}
      `),
      this.database.db.execute(sql`
        SELECT
          COALESCE(SUM(total_tokens), 0)::int AS "totalTokens",
          COALESCE(SUM(estimated_cost_usd::numeric), 0)::float AS "totalCostUsd"
        FROM run_metrics m
        JOIN runs r ON r.id = m.run_id
        WHERE r.created_at >= ${cutoff}
          AND ${runWhere}
      `)
    ]);
    const row = runResult.rows[0] as Record<string, number>;
    const signalRow = signalResult.rows[0] as Record<string, number>;
    const tokenRow = tokenResult.rows[0] as Record<string, number>;
    return {
      totalRuns: row.totalRuns ?? 0,
      activeRuns: row.activeRuns ?? 0,
      completedRuns: row.completedRuns ?? 0,
      failedRuns: row.failedRuns ?? 0,
      cancelledRuns: row.cancelledRuns ?? 0,
      totalSignals: signalRow.totalSignals ?? 0,
      totalTokens: tokenRow.totalTokens ?? 0,
      totalCostUsd: Math.round((tokenRow.totalCostUsd ?? 0) * 100) / 100
    };
  }

  private async getRunVolume(cutoff: SQL, bucket: string, filters: RunFilters) {
    const runWhere = runsWhereClause(filters);
    const result = await this.database.db.execute(sql`
      SELECT
        date_trunc(${sql.raw(`'${bucket}'`)}, r.created_at) AS bucket,
        count(*)::int AS cnt
      FROM runs r
      WHERE r.created_at >= ${cutoff}
        AND ${runWhere}
      GROUP BY 1
      ORDER BY 1
    `);
    return toSeries(result.rows, 'bucket', 'cnt');
  }

  private async getSignalVolume(cutoff: SQL, bucket: string, filters: RunFilters) {
    const runWhere = runsWhereClause(filters);
    const result = await this.database.db.execute(sql`
      SELECT
        date_trunc(${sql.raw(`'${bucket}'`)}, e.ts::timestamptz) AS bucket,
        count(*)::int AS cnt
      FROM run_events_canonical e
      JOIN runs r ON r.id = e.run_id
      WHERE e.type = 'signal.emitted'
        AND e.ts::timestamptz >= ${cutoff}
        AND ${runWhere}
      GROUP BY 1
      ORDER BY 1
    `);
    return toSeries(result.rows, 'bucket', 'cnt');
  }

  private async getErrorClasses(cutoff: SQL, filters: RunFilters) {
    const runWhere = runsWhereClause(filters);
    const result = await this.database.db.execute(sql`
      SELECT
        COALESCE(r.error_code, 'UNKNOWN') AS class,
        count(*)::int AS cnt
      FROM runs r
      WHERE r.status = 'failed'
        AND r.created_at >= ${cutoff}
        AND ${runWhere}
      GROUP BY 1
      ORDER BY cnt DESC
      LIMIT 10
    `);
    return toSeries(result.rows, 'class', 'cnt');
  }

  private async getLatencyStats(cutoff: SQL, bucket: string, filters: RunFilters) {
    const runWhere = runsWhereClause(filters);
    const [avgResult, seriesResult] = await Promise.all([
      this.database.db.execute(sql`
        SELECT
          avg(EXTRACT(EPOCH FROM (r.ended_at::timestamptz - r.started_at::timestamptz)) * 1000)::int AS "avgDurationMs"
        FROM runs r
        WHERE r.status = 'completed'
          AND r.started_at IS NOT NULL
          AND r.ended_at IS NOT NULL
          AND r.created_at >= ${cutoff}
          AND ${runWhere}
      `),
      this.database.db.execute(sql`
        SELECT
          date_trunc(${sql.raw(`'${bucket}'`)}, r.ended_at::timestamptz) AS bucket,
          avg(EXTRACT(EPOCH FROM (r.ended_at::timestamptz - r.started_at::timestamptz)) * 1000)::int AS "avgMs"
        FROM runs r
        WHERE r.status = 'completed'
          AND r.started_at IS NOT NULL
          AND r.ended_at IS NOT NULL
          AND r.created_at >= ${cutoff}
          AND ${runWhere}
        GROUP BY 1
        ORDER BY 1
      `)
    ]);
    const avgDurationMs =
      (avgResult.rows[0] as Record<string, number> | undefined)?.avgDurationMs ?? null;

    return {
      avgDurationMs,
      series: toSeries(seriesResult.rows, 'bucket', 'avgMs')
    };
  }

  private async getThroughput(cutoff: SQL, bucket: string, filters: RunFilters) {
    // Runs completed per bucket (rate of successful completions)
    const runWhere = runsWhereClause(filters);
    const result = await this.database.db.execute(sql`
      SELECT
        date_trunc(${sql.raw(`'${bucket}'`)}, r.ended_at::timestamptz) AS bucket,
        count(*) FILTER (WHERE r.status = 'completed')::int AS cnt
      FROM runs r
      WHERE r.ended_at IS NOT NULL
        AND r.ended_at::timestamptz >= ${cutoff}
        AND ${runWhere}
      GROUP BY 1
      ORDER BY 1
    `);
    return toSeries(result.rows, 'bucket', 'cnt');
  }

  private async getQueueDepth(cutoff: SQL, bucket: string, filters: RunFilters) {
    // Count of runs created in each bucket that are still in queued/starting/binding_session as of now;
    // approximates queue depth over time. (Exact historical depth would need event-sourcing of status changes.)
    const runWhere = runsWhereClause(filters);
    const result = await this.database.db.execute(sql`
      SELECT
        date_trunc(${sql.raw(`'${bucket}'`)}, r.created_at) AS bucket,
        count(*) FILTER (WHERE r.status IN ('queued','starting','binding_session'))::int AS cnt
      FROM runs r
      WHERE r.created_at >= ${cutoff}
        AND ${runWhere}
      GROUP BY 1
      ORDER BY 1
    `);
    return toSeries(result.rows, 'bucket', 'cnt');
  }

  private async getLatencyPercentiles(cutoff: SQL, bucket: string, filters: RunFilters) {
    const runWhere = runsWhereClause(filters);
    const result = await this.database.db.execute(sql`
      SELECT
        date_trunc(${sql.raw(`'${bucket}'`)}, r.ended_at::timestamptz) AS bucket,
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (r.ended_at::timestamptz - r.started_at::timestamptz)) * 1000
        )::int AS p50,
        percentile_cont(0.95) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (r.ended_at::timestamptz - r.started_at::timestamptz)) * 1000
        )::int AS p95,
        percentile_cont(0.99) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (r.ended_at::timestamptz - r.started_at::timestamptz)) * 1000
        )::int AS p99
      FROM runs r
      WHERE r.status = 'completed'
        AND r.started_at IS NOT NULL
        AND r.ended_at IS NOT NULL
        AND r.created_at >= ${cutoff}
        AND ${runWhere}
      GROUP BY 1
      ORDER BY 1
    `);
    const labels = result.rows.map((r: Record<string, unknown>) => String(r.bucket));
    return {
      p50: { labels, data: result.rows.map((r: Record<string, unknown>) => Number(r.p50 ?? 0)) },
      p95: { labels, data: result.rows.map((r: Record<string, unknown>) => Number(r.p95 ?? 0)) },
      p99: { labels, data: result.rows.map((r: Record<string, unknown>) => Number(r.p99 ?? 0)) }
    };
  }

  private async getCostSeries(cutoff: SQL, bucket: string, filters: RunFilters) {
    const runWhere = runsWhereClause(filters);
    const result = await this.database.db.execute(sql`
      SELECT
        date_trunc(${sql.raw(`'${bucket}'`)}, r.created_at) AS bucket,
        COALESCE(SUM(m.estimated_cost_usd::numeric), 0)::float AS cost
      FROM runs r
      LEFT JOIN run_metrics m ON m.run_id = r.id
      WHERE r.created_at >= ${cutoff}
        AND ${runWhere}
      GROUP BY 1
      ORDER BY 1
    `);
    return toSeries(result.rows, 'bucket', 'cost');
  }

  private async getSuccessRate(cutoff: SQL, bucket: string, filters: RunFilters) {
    // completed / (completed + failed + cancelled), as percent (0-100) per bucket
    const runWhere = runsWhereClause(filters);
    const result = await this.database.db.execute(sql`
      SELECT
        date_trunc(${sql.raw(`'${bucket}'`)}, r.created_at) AS bucket,
        CASE
          WHEN count(*) FILTER (WHERE r.status IN ('completed','failed','cancelled')) = 0 THEN 0
          ELSE (count(*) FILTER (WHERE r.status = 'completed')::float
            / count(*) FILTER (WHERE r.status IN ('completed','failed','cancelled'))::float * 100)
        END AS rate
      FROM runs r
      WHERE r.created_at >= ${cutoff}
        AND ${runWhere}
      GROUP BY 1
      ORDER BY 1
    `);
    return toSeries(result.rows, 'bucket', 'rate');
  }

  private async getDecisionOutcome(cutoff: SQL, bucket: string, filters: RunFilters) {
    // Positive / negative outcome counts per bucket, surfaced as a single series of "positive - negative"
    const runWhere = runsWhereClause(filters);
    const result = await this.database.db.execute(sql`
      SELECT
        date_trunc(${sql.raw(`'${bucket}'`)}, e.ts::timestamptz) AS bucket,
        count(*) FILTER (WHERE (e.data->'decodedPayload'->>'outcome_positive')::boolean = true
          OR (e.data->'decodedPayload'->>'outcomePositive')::boolean = true)::int AS positive,
        count(*) FILTER (WHERE (e.data->'decodedPayload'->>'outcome_positive')::boolean = false
          OR (e.data->'decodedPayload'->>'outcomePositive')::boolean = false)::int AS negative
      FROM run_events_canonical e
      JOIN runs r ON r.id = e.run_id
      WHERE e.type = 'decision.finalized'
        AND e.ts::timestamptz >= ${cutoff}
        AND ${runWhere}
      GROUP BY 1
      ORDER BY 1
    `);
    // Net outcome per bucket (positive − negative) — UI can also read raw rows if needed
    return {
      labels: result.rows.map((r: Record<string, unknown>) => String(r.bucket)),
      data: result.rows.map((r: Record<string, unknown>) =>
        Number(r.positive ?? 0) - Number(r.negative ?? 0)
      )
    };
  }

  private async getPerScenarioVolume(cutoff: SQL, filters: RunFilters) {
    const runWhere = runsWhereClause(filters);
    const result = await this.database.db.execute(sql`
      SELECT
        COALESCE(r.source_ref, 'unknown') AS scenario,
        count(*)::int AS cnt
      FROM runs r
      WHERE r.created_at >= ${cutoff}
        AND ${runWhere}
      GROUP BY 1
      ORDER BY cnt DESC
      LIMIT 10
    `);
    return toSeries(result.rows, 'scenario', 'cnt');
  }

  private async getRecentRuns(filters: RunFilters) {
    const data = await this.runRepository.list({
      limit: 10,
      offset: 0,
      sortBy: 'createdAt',
      sortOrder: 'desc',
      includeArchived: false,
      includeSandbox: false,
      scenarioRef: filters.scenarioRef,
      environment: filters.environment
    });
    return data.map((row) => ({
      id: row.id,
      status: row.status,
      runtimeKind: row.runtimeKind,
      sourceRef: row.sourceRef ?? undefined,
      startedAt: row.startedAt ?? undefined,
      endedAt: row.endedAt ?? undefined,
      createdAt: row.createdAt
    }));
  }

  async getAgentMetrics() {
    const result = await this.database.db.execute(sql`
      SELECT
        subject_id AS "participantId",
        count(DISTINCT run_id)::int AS runs,
        count(*) FILTER (WHERE type LIKE 'message.%')::int AS messages,
        count(*) FILTER (WHERE type = 'signal.emitted')::int AS signals,
        avg(CASE WHEN type = 'signal.emitted' AND (data->>'confidence') IS NOT NULL
            THEN (data->>'confidence')::numeric ELSE NULL END)::float AS "averageConfidence"
      FROM run_events_canonical
      WHERE subject_kind = 'participant'
        AND subject_id IS NOT NULL
      GROUP BY subject_id
      ORDER BY runs DESC
    `);
    return result.rows.map((r: Record<string, unknown>) => ({
      participantId: String(r.participantId),
      runs: Number(r.runs ?? 0),
      signals: Number(r.signals ?? 0),
      messages: Number(r.messages ?? 0),
      averageConfidence: r.averageConfidence != null ? Number(r.averageConfidence) : 0
    }));
  }

  private async getRuntimeHealth() {
    try {
      const kinds = this.runtimeRegistry.listKinds();
      if (kinds.length === 0) {
        return { ok: false, runtimeKind: 'none', detail: 'No runtime providers registered' };
      }
      const provider = this.runtimeRegistry.get(kinds[0]);
      const health = await provider.health();
      return {
        ok: health.ok,
        runtimeKind: health.runtimeKind ?? kinds[0],
        detail: health.detail ?? undefined
      };
    } catch (err) {
      this.logger.warn(`Runtime health check failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, runtimeKind: 'unknown', detail: 'Runtime unreachable' };
    }
  }
}
