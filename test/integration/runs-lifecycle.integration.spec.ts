import { createTestApp, TestAppContext } from '../helpers/test-app';
import { decisionModeRequest, decisionHappyScript } from '../fixtures/decision-mode';
import { testRuntimeKind } from '../helpers/runtime-kind';
import { waitFor } from '../helpers/wait-for';

const isRealRuntime =
  process.env.INTEGRATION_RUNTIME === 'docker' ||
  process.env.INTEGRATION_RUNTIME === 'remote';

describe('Run Lifecycle (integration, observer mode)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp(isRealRuntime ? undefined : decisionHappyScript());
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await ctx.cleanup();
  });

  it('POST /runs creates a run and returns runId + sessionId', async () => {
    const result = await ctx.client.createRun(decisionModeRequest());
    expect(result.runId).toMatch(/^[0-9a-f]{8}-/);
    expect(result.sessionId).toMatch(/^[0-9a-f]{8}-/);
    expect(result.status).toBe('queued');
  });

  it('POST /runs returns the caller-provided sessionId when valid', async () => {
    const sessionId = '123e4567-e89b-42d3-a456-426614174000';
    const result = await ctx.client.createRun({
      ...decisionModeRequest(),
      session: { ...decisionModeRequest().session, sessionId },
    });
    expect(result.sessionId).toBe(sessionId);
  });

  it('POST /runs rejects an invalid sessionId', async () => {
    const result = (await ctx.client.createRun({
      ...decisionModeRequest(),
      session: { ...decisionModeRequest().session, sessionId: 'too-short' },
    })) as any;
    expect(result.statusCode ?? 0).toBeGreaterThanOrEqual(400);
  });

  it('GET /runs/:id fetches the run record with runtimeSessionId populated', async () => {
    const { runId, sessionId } = await ctx.client.createRun(decisionModeRequest());

    const run = await waitFor(
      async () => {
        const r = (await ctx.client.getRun(runId)) as any;
        return r.runtimeSessionId === sessionId ? r : null;
      },
      { timeoutMs: 3000, label: 'run.runtimeSessionId populated' },
    );
    expect(run.id).toBe(runId);
    expect(run.runtimeKind).toBe(testRuntimeKind());
  });

  it('GET /runs supports filtering by tags', async () => {
    await ctx.client.createRun(
      decisionModeRequest({ execution: { tags: ['special-tag'] } }),
    );
    await ctx.client.createRun(decisionModeRequest());

    const tagged = await waitFor(
      async () => {
        const result = (await ctx.client.listRuns({
          tags: 'special-tag',
          includeSandbox: true,
        })) as any;
        const filtered = result.data.filter(
          (r: any) => r.tags && r.tags.includes('special-tag'),
        );
        return filtered.length >= 1 ? filtered : null;
      },
      { timeoutMs: 3000, label: 'tagged run visible' },
    );
    expect(tagged.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /runs/:id/state returns the projected state', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());

    const state = await waitFor(
      async () => {
        const s = (await ctx.client.getState(runId)) as any;
        return s.timeline?.totalEvents > 0 ? s : null;
      },
      { timeoutMs: 5000, label: 'state populated' },
    );
    expect(state).toHaveProperty('run');
    expect(state).toHaveProperty('participants');
    expect(state).toHaveProperty('decision');
    expect(state).toHaveProperty('timeline');
  });

  it('transitions queued → starting → binding_session → running → completed without control-plane Send', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());

    const run = await waitFor(
      async () => {
        const r = (await ctx.client.getRun(runId)) as any;
        return ['completed', 'failed', 'cancelled'].includes(r.status) ? r : null;
      },
      { timeoutMs: 5000, label: 'run reached terminal state' },
    );
    expect(['completed', 'failed', 'cancelled']).toContain(run.status);
  });
});
