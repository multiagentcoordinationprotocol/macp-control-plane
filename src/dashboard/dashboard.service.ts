import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../db/database.service';
import { RunRepository } from '../storage/run.repository';
import { RuntimeProviderRegistry } from '../runtime/runtime-provider.registry';

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly runRepository: RunRepository,
    private readonly runtimeRegistry: RuntimeProviderRegistry
  ) {}

  async getOverview(range: '24h' | '7d' | '30d' = '24h') {
    const interval = range === '24h' ? '24 hours' : range === '7d' ? '7 days' : '30 days';
    const bucket = range === '24h' ? '1 hour' : '1 day';
    const cutoff = sql`now() - interval '${sql.raw(interval)}'`;

    const [kpis, volumeSeries, signalSeries, errorSeries, latencyStats, recentRuns, runtimeHealth] =
      await Promise.all([
        this.getKpis(cutoff),
        this.getRunVolume(cutoff, bucket),
        this.getSignalVolume(cutoff, bucket),
        this.getErrorClasses(cutoff),
        this.getLatencyStats(cutoff, bucket),
        this.getRecentRuns(),
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
        errorClasses: errorSeries
      }
    };
  }

  private async getKpis(cutoff: ReturnType<typeof sql>) {
    const [runResult, signalResult, tokenResult] = await Promise.all([
      this.database.db.execute(sql`
        SELECT
          count(*)::int AS "totalRuns",
          count(*) FILTER (WHERE status IN ('queued','starting','binding_session','running'))::int AS "activeRuns",
          count(*) FILTER (WHERE status = 'completed')::int AS "completedRuns",
          count(*) FILTER (WHERE status = 'failed')::int AS "failedRuns",
          count(*) FILTER (WHERE status = 'cancelled')::int AS "cancelledRuns"
        FROM runs
        WHERE created_at >= ${cutoff}
      `),
      this.database.db.execute(sql`
        SELECT count(*)::int AS "totalSignals"
        FROM run_events_canonical
        WHERE type = 'signal.emitted'
          AND ts::timestamptz >= ${cutoff}
      `),
      this.database.db.execute(sql`
        SELECT
          COALESCE(SUM(total_tokens), 0)::int AS "totalTokens",
          COALESCE(SUM(estimated_cost_usd::numeric), 0)::float AS "totalCostUsd"
        FROM run_metrics m
        JOIN runs r ON r.id = m.run_id
        WHERE r.created_at >= ${cutoff}
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

  private async getRunVolume(cutoff: ReturnType<typeof sql>, bucket: string) {
    const result = await this.database.db.execute(sql`
      SELECT
        date_trunc(${sql.raw(`'${bucket}'`)}, created_at) AS bucket,
        count(*)::int AS cnt
      FROM runs
      WHERE created_at >= ${cutoff}
      GROUP BY 1
      ORDER BY 1
    `);
    return {
      labels: result.rows.map((r: Record<string, unknown>) => String(r.bucket)),
      data: result.rows.map((r: Record<string, unknown>) => Number(r.cnt))
    };
  }

  private async getSignalVolume(cutoff: ReturnType<typeof sql>, bucket: string) {
    const result = await this.database.db.execute(sql`
      SELECT
        date_trunc(${sql.raw(`'${bucket}'`)}, ts::timestamptz) AS bucket,
        count(*)::int AS cnt
      FROM run_events_canonical
      WHERE type = 'signal.emitted'
        AND ts::timestamptz >= ${cutoff}
      GROUP BY 1
      ORDER BY 1
    `);
    return {
      labels: result.rows.map((r: Record<string, unknown>) => String(r.bucket)),
      data: result.rows.map((r: Record<string, unknown>) => Number(r.cnt))
    };
  }

  private async getErrorClasses(cutoff: ReturnType<typeof sql>) {
    const result = await this.database.db.execute(sql`
      SELECT
        COALESCE(error_code, 'UNKNOWN') AS class,
        count(*)::int AS cnt
      FROM runs
      WHERE status = 'failed'
        AND created_at >= ${cutoff}
      GROUP BY 1
      ORDER BY cnt DESC
      LIMIT 10
    `);
    return {
      labels: result.rows.map((r: Record<string, unknown>) => String(r.class)),
      data: result.rows.map((r: Record<string, unknown>) => Number(r.cnt))
    };
  }

  private async getLatencyStats(cutoff: ReturnType<typeof sql>, bucket: string) {
    const [avgResult, seriesResult] = await Promise.all([
      this.database.db.execute(sql`
        SELECT
          avg(EXTRACT(EPOCH FROM (ended_at::timestamptz - started_at::timestamptz)) * 1000)::int AS "avgDurationMs"
        FROM runs
        WHERE status = 'completed'
          AND started_at IS NOT NULL
          AND ended_at IS NOT NULL
          AND created_at >= ${cutoff}
      `),
      this.database.db.execute(sql`
        SELECT
          date_trunc(${sql.raw(`'${bucket}'`)}, ended_at::timestamptz) AS bucket,
          avg(EXTRACT(EPOCH FROM (ended_at::timestamptz - started_at::timestamptz)) * 1000)::int AS "avgMs"
        FROM runs
        WHERE status = 'completed'
          AND started_at IS NOT NULL
          AND ended_at IS NOT NULL
          AND created_at >= ${cutoff}
        GROUP BY 1
        ORDER BY 1
      `)
    ]);
    const avgDurationMs =
      (avgResult.rows[0] as Record<string, number> | undefined)?.avgDurationMs ?? null;

    return {
      avgDurationMs,
      series: {
        labels: seriesResult.rows.map((r: Record<string, unknown>) => String(r.bucket)),
        data: seriesResult.rows.map((r: Record<string, unknown>) => Number(r.avgMs ?? 0))
      }
    };
  }

  private async getRecentRuns() {
    const data = await this.runRepository.list({
      limit: 10,
      offset: 0,
      sortBy: 'createdAt',
      sortOrder: 'desc',
      includeArchived: false,
      includeSandbox: false
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
