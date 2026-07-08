import { createTestApp, TestAppContext } from '../helpers/test-app';
import { decisionModeRequest, decisionSlowScript } from '../fixtures/decision-mode';
import { waitFor } from '../helpers/wait-for';

const isRealRuntime =
  process.env.INTEGRATION_RUNTIME === 'docker' ||
  process.env.INTEGRATION_RUNTIME === 'remote';

/**
 * Suspend / resume lifecycle (macp-proto 0.1.3, RFC-MACP-0001 §7.5).
 *
 * Uses decisionSlowScript so the run stays `running` for ~8s — long enough to
 * exercise suspend/resume deterministically before the final Commitment lands.
 */
(isRealRuntime ? describe.skip : describe)('Run Suspend/Resume (integration)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp(decisionSlowScript());
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  // Commitment lands only after 60s so it never races the suspend/resume state
  // assertions (the mock keeps emitting regardless of suspension — a shorter
  // window could finalize the run mid-test on a slow CI host). The finalize test
  // below installs a short-window script of its own.
  const NEVER_DURING_TEST_MS = 60000;

  beforeEach(async () => {
    await ctx.cleanup();
    ctx.mockRuntime.setScript(decisionSlowScript(NEVER_DURING_TEST_MS));
  });

  async function createRunningRun(): Promise<string> {
    const { runId } = await ctx.client.createRun(decisionModeRequest());
    await waitFor(
      async () => {
        const r = (await ctx.client.getRun(runId)) as any;
        return r.status === 'running' ? r : null;
      },
      { timeoutMs: 5000, label: 'run running' },
    );
    return runId;
  }

  it('suspends a running run: status suspended + run.suspended canonical event', async () => {
    const runId = await createRunningRun();

    const suspended = (await ctx.client.request('POST', `/runs/${runId}/suspend`, {
      body: { reason: 'integration test suspend' },
    })) as any;
    expect(suspended.statusCode).toBeUndefined();
    expect(suspended.status).toBe('suspended');

    const run = (await ctx.client.getRun(runId)) as any;
    expect(run.status).toBe('suspended');

    const events = await waitFor(
      async () => {
        const e = (await ctx.client.listEvents(runId)) as any[];
        return e.some((ev) => ev.type === 'run.suspended') ? e : null;
      },
      { timeoutMs: 3000, label: 'run.suspended canonical event' },
    );
    expect(events.filter((ev) => ev.type === 'run.suspended').length).toBeGreaterThanOrEqual(1);
  });

  it('rejects suspend while run is not yet running (400)', async () => {
    // Delay session-open so the run parks in `starting` while GetSession polls.
    ctx.mockRuntime.setScript({ ...decisionSlowScript(NEVER_DURING_TEST_MS), sessionOpenAfterMs: 5000 });
    const { runId } = await ctx.client.createRun(decisionModeRequest());

    await waitFor(
      async () => {
        const r = (await ctx.client.getRun(runId)) as any;
        return ['queued', 'starting'].includes(r.status) && r.id === runId ? r : null;
      },
      { timeoutMs: 3000, label: 'run visible in pre-running state' },
    );

    const result = (await ctx.client.request('POST', `/runs/${runId}/suspend`, { body: {} })) as any;
    expect(result.statusCode).toBe(400);
    expect(String(result.message)).toContain('only running runs can be suspended');
  });

  it('rejects suspend of an already-suspended run (400)', async () => {
    const runId = await createRunningRun();

    const first = (await ctx.client.request('POST', `/runs/${runId}/suspend`, { body: {} })) as any;
    expect(first.status).toBe('suspended');

    const second = (await ctx.client.request('POST', `/runs/${runId}/suspend`, { body: {} })) as any;
    expect(second.statusCode).toBe(400);
    expect(String(second.message)).toContain('only running runs can be suspended');
  });

  it('resumes a suspended run: status running + run.resumed canonical event', async () => {
    const runId = await createRunningRun();

    await ctx.client.request('POST', `/runs/${runId}/suspend`, { body: {} });

    const resumed = (await ctx.client.request('POST', `/runs/${runId}/resume`, {
      body: { reason: 'integration test resume' },
    })) as any;
    expect(resumed.statusCode).toBeUndefined();
    expect(resumed.status).toBe('running');

    const events = await waitFor(
      async () => {
        const e = (await ctx.client.listEvents(runId)) as any[];
        return e.some((ev) => ev.type === 'run.resumed') ? e : null;
      },
      { timeoutMs: 3000, label: 'run.resumed canonical event' },
    );
    expect(events.filter((ev) => ev.type === 'run.resumed').length).toBeGreaterThanOrEqual(1);
  });

  it('rejects resume when run is not suspended (400)', async () => {
    const runId = await createRunningRun();

    const result = (await ctx.client.request('POST', `/runs/${runId}/resume`, { body: {} })) as any;
    expect(result.statusCode).toBe(400);
    expect(String(result.message)).toContain('only suspended runs can be resumed');
  });

  it('suspend and resume of a nonexistent run return 404', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';

    const suspendResult = (await ctx.client.request('POST', `/runs/${missing}/suspend`, { body: {} })) as any;
    expect(suspendResult.statusCode).toBe(404);

    const resumeResult = (await ctx.client.request('POST', `/runs/${missing}/resume`, { body: {} })) as any;
    expect(resumeResult.statusCode).toBe(404);
  });

  it('after resume, the run still finalizes completed when the slow Commitment lands', async () => {
    // Window wide enough that suspend+resume always complete first even under
    // post-load slowness (racing a shorter wall-clock timer would let the
    // Commitment finalize the run before resume, flipping resume to 400), yet
    // short enough to land inside the terminal wait below.
    ctx.mockRuntime.setScript(decisionSlowScript(15000));
    const runId = await createRunningRun();

    await ctx.client.request('POST', `/runs/${runId}/suspend`, { body: {} });
    const resumed = (await ctx.client.request('POST', `/runs/${runId}/resume`, { body: {} })) as any;
    expect(resumed.status).toBe('running');

    const terminal = await waitFor(
      async () => {
        const r = (await ctx.client.getRun(runId)) as any;
        return ['completed', 'failed', 'cancelled'].includes(r.status) ? r : null;
      },
      { timeoutMs: 25000, label: 'run terminal after slow commitment' },
    );
    expect(terminal.status).toBe('completed');

    // run.completed is a control-plane event emitted just after the status
    // transition, so poll for it rather than reading immediately after the run
    // record flips (the canonical event can lag the record by a beat).
    const events = await waitFor(
      async () => {
        const e = (await ctx.client.listEvents(runId)) as any[];
        return e.some((ev) => ev.type === 'run.completed') ? e : null;
      },
      { timeoutMs: 5000, label: 'run.completed event persisted' },
    );
    const types = events.map((e) => e.type);
    expect(types).toContain('run.suspended');
    expect(types).toContain('run.resumed');
    expect(types).toContain('run.completed');
  });
});
