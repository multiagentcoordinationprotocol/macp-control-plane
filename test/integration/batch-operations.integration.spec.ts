import { createTestApp, TestAppContext } from '../helpers/test-app';
import {
  decisionModeRequest,
  decisionHappyScript,
  decisionSlowScript,
} from '../fixtures/decision-mode';
import { waitFor } from '../helpers/wait-for';

const isRealRuntime =
  process.env.INTEGRATION_RUNTIME === 'docker' ||
  process.env.INTEGRATION_RUNTIME === 'remote';

const MISSING_RUN_ID = '00000000-0000-4000-8000-000000000000';

/**
 * Batch operations + run comparison (src/controllers/run-insights.controller.ts).
 */
(isRealRuntime ? describe.skip : describe)('Batch Operations (integration)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp(decisionHappyScript());
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await ctx.cleanup();
    ctx.mockRuntime.setScript(decisionHappyScript());
  });

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

  /** A run that stays `running` (slow Commitment), optionally cancellable via Option B delegation. */
  async function runningRun(opts?: { delegated?: boolean }): Promise<string> {
    ctx.mockRuntime.setScript(decisionSlowScript());
    const request = opts?.delegated
      ? decisionModeRequest({
          session: {
            ...decisionModeRequest().session,
            metadata: { cancellationDelegated: true },
          },
        })
      : decisionModeRequest();
    const { runId } = await ctx.client.createRun(request);
    await waitFor(
      async () => {
        const r = (await ctx.client.getRun(runId)) as any;
        return r.status === 'running' ? r : null;
      },
      { timeoutMs: 5000, label: 'run running' },
    );
    return runId;
  }

  describe('POST /runs/compare', () => {
    it('compares two completed runs: statuses + delta fields + participant diff', async () => {
      const leftRunId = await completedRun();
      const rightRunId = await completedRun();

      const result = (await ctx.client.request('POST', '/runs/compare', {
        body: { leftRunId, rightRunId },
      })) as any;

      expect(result.left.runId).toBe(leftRunId);
      expect(result.left.status).toBe('completed');
      expect(result.right.runId).toBe(rightRunId);
      expect(result.right.status).toBe('completed');
      expect(result.statusMatch).toBe(true);
      expect(typeof result.durationDeltaMs).toBe('number');
      // confidenceDelta is undefined (and therefore omitted from the JSON body)
      // when either projection lacks an explicit decision confidence.
      expect(result.participantsDiff.common.sort()).toEqual(['evaluator', 'proposer', 'voter']);
      expect(result.participantsDiff.added).toEqual([]);
      expect(result.participantsDiff.removed).toEqual([]);
      expect(result.signalsDiff).toEqual({ added: [], removed: [] });
    });

    it('returns 404 when one run is missing', async () => {
      const leftRunId = await completedRun();
      const result = (await ctx.client.request('POST', '/runs/compare', {
        body: { leftRunId, rightRunId: MISSING_RUN_ID },
      })) as any;
      expect(result.statusCode).toBe(404);
    });
  });

  describe('POST /runs/batch/archive', () => {
    it('archives every run in the batch and reports per-run status', async () => {
      const runA = await completedRun();
      const runB = await completedRun();

      const results = (await ctx.client.request('POST', '/runs/batch/archive', {
        body: { runIds: [runA, runB] },
      })) as any[];

      expect(results.find((r) => r.runId === runA)?.status).toBe('archived');
      expect(results.find((r) => r.runId === runB)?.status).toBe('archived');

      const withArchived = (await ctx.client.listRuns({
        includeSandbox: true,
        includeArchived: true,
      })) as any;
      const allIds = withArchived.data.map((r: any) => r.id);
      expect(allIds).toContain(runA);
      expect(allIds).toContain(runB);

      const withoutArchived = (await ctx.client.listRuns({ includeSandbox: true })) as any;
      const visibleIds = withoutArchived.data.map((r: any) => r.id);
      expect(visibleIds).not.toContain(runA);
      expect(visibleIds).not.toContain(runB);
    });

    it('archiving runs excludes them from default listing, included with includeArchived=true', async () => {
      const runA = await completedRun();
      const runB = await completedRun();

      const results = (await ctx.client.request('POST', '/runs/batch/archive', {
        body: { runIds: [runA, runB] },
      })) as any[];
      expect(results.every((r) => r.status === 'archived')).toBe(true);

      // Runs here are sandbox-mode, so includeSandbox is needed either way.
      const withoutArchived = (await ctx.client.listRuns({ includeSandbox: true })) as any;
      const visibleIds = withoutArchived.data.map((r: any) => r.id);
      expect(visibleIds).not.toContain(runA);
      expect(visibleIds).not.toContain(runB);

      const withArchived = (await ctx.client.listRuns({
        includeSandbox: true,
        includeArchived: true,
      })) as any;
      const allIds = withArchived.data.map((r: any) => r.id);
      expect(allIds).toContain(runA);
      expect(allIds).toContain(runB);
    });
  });

  describe('POST /runs/batch/export', () => {
    it('returns a bundle per runId', async () => {
      const runA = await completedRun();
      const runB = await completedRun();

      const bundles = (await ctx.client.request('POST', '/runs/batch/export', {
        body: { runIds: [runA, runB] },
      })) as any[];

      expect(bundles.length).toBe(2);
      expect(bundles.map((b) => b.run.id)).toEqual([runA, runB]);
      for (const bundle of bundles) {
        expect(bundle.run.status).toBe('completed');
        expect(bundle.projection).toBeTruthy();
        expect(Array.isArray(bundle.canonicalEvents)).toBe(true);
        expect(bundle.canonicalEvents.length).toBeGreaterThan(0);
        expect(bundle.exportedAt).toBeDefined();
      }
    });

    it('an unknown id fails the whole batch with 404 (export is all-or-nothing)', async () => {
      // batchExport uses Promise.all deliberately — an export bundle is atomic, so
      // a single unknown runId rejects the whole request with 404 rather than
      // returning a partial bundle set. (cancel/archive/delete are partial-tolerant
      // via Promise.allSettled because they are independent mutations.)
      const runA = await completedRun();
      const result = (await ctx.client.request('POST', '/runs/batch/export', {
        body: { runIds: [runA, MISSING_RUN_ID] },
      })) as any;
      expect(result.statusCode).toBe(404);
    });
  });

  describe('POST /runs/batch/delete', () => {
    it('deletes terminal runs; a non-terminal id in the same list is reported failed while others succeed', async () => {
      const runA = await completedRun();
      const runB = await completedRun();
      const stillRunning = await runningRun();

      const results = (await ctx.client.request('POST', '/runs/batch/delete', {
        body: { runIds: [runA, runB, stillRunning] },
      })) as any[];

      expect(results.find((r) => r.runId === runA)?.status).toBe('deleted');
      expect(results.find((r) => r.runId === runB)?.status).toBe('deleted');
      const failed = results.find((r) => r.runId === stillRunning);
      expect(failed?.status).toBe('failed');
      expect(String(failed?.error)).toContain('only terminal runs');

      for (const deletedId of [runA, runB]) {
        const gone = (await ctx.client.getRun(deletedId)) as any;
        expect(gone.statusCode).toBe(404);
      }
      const survivor = (await ctx.client.getRun(stillRunning)) as any;
      expect(survivor.status).toBe('running');
    });
  });

  describe('POST /runs/batch/cancel', () => {
    it('cancels delegated runs in a batch and reports per-run status', async () => {
      const runId = await runningRun({ delegated: true });

      const results = (await ctx.client.request('POST', '/runs/batch/cancel', {
        body: { runIds: [runId] },
      })) as any[];

      expect(results.find((r) => r.runId === runId)?.status).toBe('cancelled');

      const run = await waitFor(
        async () => {
          const r = (await ctx.client.getRun(runId)) as any;
          return r.status === 'cancelled' ? r : null;
        },
        { timeoutMs: 5000, label: 'run cancelled' },
      );
      expect(run.status).toBe('cancelled');
    });

    it('reports failed for a run that cannot be cancelled without failing the batch', async () => {
      const delegated = await runningRun({ delegated: true });
      const missing = MISSING_RUN_ID;

      const results = (await ctx.client.request('POST', '/runs/batch/cancel', {
        body: { runIds: [delegated, missing] },
      })) as any[];

      expect(results.find((r) => r.runId === delegated)?.status).toBe('cancelled');
      expect(results.find((r) => r.runId === missing)?.status).toBe('failed');
    });
  });
});
