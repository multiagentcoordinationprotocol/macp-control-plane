import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { and, inArray, lt } from 'drizzle-orm';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseService } from '../db/database.service';
import { auditLog, runs, webhookDeliveries } from '../db/schema';

const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];

@Injectable()
export class DataRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DataRetentionService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly database: DatabaseService
  ) {}

  onModuleInit(): void {
    if (!this.config.dataRetentionEnabled) {
      this.logger.log('Data retention is disabled (DATA_RETENTION_ENABLED=false)');
      return;
    }

    const intervalMs = this.config.dataRetentionIntervalHours * 60 * 60 * 1000;
    this.logger.log(
      `Data retention enabled: TTL=${this.config.dataRetentionTtlDays}d, interval=${this.config.dataRetentionIntervalHours}h, batch=${this.config.dataRetentionBatchSize}`
    );

    // Run once at startup (after a short delay to let app stabilize), then on interval
    const startupDelay = setTimeout(() => {
      void this.runRetention();
    }, 10_000);
    if (typeof startupDelay === 'object' && 'unref' in startupDelay) startupDelay.unref();

    this.timer = setInterval(() => {
      void this.runRetention();
    }, intervalMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runRetention(): Promise<{ deletedRuns: number; deletedAuditLogs: number; deletedWebhookDeliveries: number }> {
    const lockKey = 'data-retention-lock';
    const acquired = await this.database.tryAdvisoryLock(lockKey);
    if (!acquired) {
      this.logger.debug('Another instance is running retention — skipping');
      return { deletedRuns: 0, deletedAuditLogs: 0, deletedWebhookDeliveries: 0 };
    }

    try {
      const cutoff = new Date(Date.now() - this.config.dataRetentionTtlDays * 24 * 60 * 60 * 1000).toISOString();
      this.logger.log(`Running data retention: purging data older than ${cutoff}`);

      const deletedRuns = await this.purgeTerminalRuns(cutoff);
      const deletedAuditLogs = await this.purgeAuditLogs(cutoff);
      const deletedWebhookDeliveries = await this.purgeWebhookDeliveries(cutoff);

      this.logger.log(
        `Retention complete: ${deletedRuns} runs, ${deletedAuditLogs} audit logs, ${deletedWebhookDeliveries} webhook deliveries purged`
      );

      return { deletedRuns, deletedAuditLogs, deletedWebhookDeliveries };
    } catch (err) {
      this.logger.error(`Data retention failed: ${(err as Error).message}`, (err as Error).stack);
      return { deletedRuns: 0, deletedAuditLogs: 0, deletedWebhookDeliveries: 0 };
    } finally {
      await this.database.advisoryUnlock(lockKey);
    }
  }

  /**
   * Delete terminal runs (completed/failed/cancelled) older than cutoff.
   * Child tables (events, projections, metrics, sessions, artifacts, outbound messages)
   * are cascade-deleted by FK constraints.
   */
  private async purgeTerminalRuns(cutoff: string): Promise<number> {
    let total = 0;
    let deleted: number;

    do {
      const staleIds = await this.database.db
        .select({ id: runs.id })
        .from(runs)
        .where(and(inArray(runs.status, TERMINAL_STATUSES), lt(runs.endedAt, cutoff)))
        .limit(this.config.dataRetentionBatchSize);

      if (staleIds.length === 0) break;

      const ids = staleIds.map((r) => r.id);
      const result = await this.database.db.delete(runs).where(inArray(runs.id, ids));

      deleted = (result as unknown as { rowCount: number }).rowCount ?? ids.length;
      total += deleted;

      this.logger.debug(`Purged batch of ${deleted} terminal runs`);
    } while (deleted === this.config.dataRetentionBatchSize);

    return total;
  }

  private async purgeAuditLogs(cutoff: string): Promise<number> {
    const result = await this.database.db.delete(auditLog).where(lt(auditLog.createdAt, cutoff));

    return (result as unknown as { rowCount: number }).rowCount ?? 0;
  }

  private async purgeWebhookDeliveries(cutoff: string): Promise<number> {
    const result = await this.database.db.delete(webhookDeliveries).where(lt(webhookDeliveries.createdAt, cutoff));

    return (result as unknown as { rowCount: number }).rowCount ?? 0;
  }
}
