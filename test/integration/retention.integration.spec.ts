import { randomUUID } from 'node:crypto';
import { createTestApp, TestAppContext } from '../helpers/test-app';
import { decisionModeRequest, decisionHappyScript } from '../fixtures/decision-mode';
import { waitFor } from '../helpers/wait-for';
import { DataRetentionService } from '../../src/retention/data-retention.service';
import { DatabaseService } from '../../src/db/database.service';

/**
 * Data retention sweep (src/retention/data-retention.service.ts).
 *
 * `runRetention()` is public and not gated on DATA_RETENTION_ENABLED, so tests
 * invoke it directly. TTL defaults to 30 days — rows are backdated 31 days via
 * raw SQL through the app's own pool.
 */
describe('Data Retention (integration)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp(decisionHappyScript());
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await ctx.cleanup();
  });

  function pool() {
    return ctx.module.get(DatabaseService).pool;
  }

  async function completedRun(): Promise<string> {
    const { runId } = await ctx.client.createRun(decisionModeRequest());
    await waitFor(
      async () => {
        const r = (await ctx.client.getRun(runId)) as any;
        return r.status === 'completed' ? r : null;
      },
      { timeoutMs: 10000, label: 'run completed' },
    );
    return runId;
  }

  async function countRows(table: string, runIds: string[]): Promise<number> {
    const res = await pool().query(`SELECT count(*)::int AS n FROM ${table} WHERE run_id = ANY($1)`, [runIds]);
    return res.rows[0].n;
  }

  it('purges backdated terminal runs (with cascaded children), old audit logs and webhook deliveries; keeps recent and non-terminal runs; second sweep is a no-op', async () => {
    // Two completed runs backdated beyond the 30d TTL.
    const oldRun1 = await completedRun();
    const oldRun2 = await completedRun();
    // A recent completed run that must survive.
    const recentRun = await completedRun();

    await pool().query(
      `UPDATE runs SET ended_at = now() - interval '31 days' WHERE id = ANY($1)`,
      [[oldRun1, oldRun2]],
    );

    // A non-terminal run, even ancient, must survive (only terminal statuses are purged).
    const staleRunningRun = randomUUID();
    await pool().query(
      `INSERT INTO runs (id, status, mode, runtime_kind, created_at, updated_at)
       VALUES ($1, 'running', 'sandbox', 'scripted-mock', now() - interval '40 days', now() - interval '40 days')`,
      [staleRunningRun],
    );

    // Old audit_log row.
    const oldAuditId = randomUUID();
    await pool().query(
      `INSERT INTO audit_log (id, actor, actor_type, action, resource, resource_id, details, created_at)
       VALUES ($1, 'integration-test', 'system', 'test.backdated', 'run', $2, '{}'::jsonb, now() - interval '31 days')`,
      [oldAuditId, oldRun1],
    );

    // Old webhook delivery (needs a parent webhook row).
    const webhookId = randomUUID();
    const oldDeliveryId = randomUUID();
    await pool().query(
      `INSERT INTO webhooks (id, url, events, secret) VALUES ($1, 'http://127.0.0.1:9/dead', '[]'::jsonb, 's3cret')`,
      [webhookId],
    );
    await pool().query(
      `INSERT INTO webhook_deliveries (id, webhook_id, event, run_id, payload, status, attempts, created_at)
       VALUES ($1, $2, 'run.completed', $3, '{}'::jsonb, 'delivered', 1, now() - interval '31 days')`,
      [oldDeliveryId, webhookId, oldRun1],
    );

    // Sanity: children exist for the backdated runs before the sweep.
    expect(await countRows('run_events_canonical', [oldRun1, oldRun2])).toBeGreaterThan(0);
    expect(await countRows('run_projections', [oldRun1, oldRun2])).toBeGreaterThan(0);
    expect(await countRows('runtime_sessions', [oldRun1, oldRun2])).toBeGreaterThan(0);

    const retention = ctx.module.get(DataRetentionService);
    const result = await retention.runRetention();

    expect(result.deletedRuns).toBe(2);
    expect(result.deletedAuditLogs).toBe(1);
    expect(result.deletedWebhookDeliveries).toBe(1);

    // Purged runs and all cascaded children are gone.
    const remainingRuns = await pool().query(`SELECT id FROM runs WHERE id = ANY($1)`, [[oldRun1, oldRun2]]);
    expect(remainingRuns.rows.length).toBe(0);
    expect(await countRows('run_events_canonical', [oldRun1, oldRun2])).toBe(0);
    expect(await countRows('run_projections', [oldRun1, oldRun2])).toBe(0);
    expect(await countRows('runtime_sessions', [oldRun1, oldRun2])).toBe(0);

    const oldAudit = await pool().query(`SELECT id FROM audit_log WHERE id = $1`, [oldAuditId]);
    expect(oldAudit.rows.length).toBe(0);
    const oldDelivery = await pool().query(`SELECT id FROM webhook_deliveries WHERE id = $1`, [oldDeliveryId]);
    expect(oldDelivery.rows.length).toBe(0);

    // Recent completed run and the non-terminal run survive with all their data.
    const recent = (await ctx.client.getRun(recentRun)) as any;
    expect(recent.status).toBe('completed');
    expect(await countRows('run_events_canonical', [recentRun])).toBeGreaterThan(0);
    const staleRunning = await pool().query(`SELECT status FROM runs WHERE id = $1`, [staleRunningRun]);
    expect(staleRunning.rows[0]?.status).toBe('running');

    // Second sweep: nothing left to purge.
    const second = await retention.runRetention();
    expect(second).toEqual({ deletedRuns: 0, deletedAuditLogs: 0, deletedWebhookDeliveries: 0 });
  });
});
