import { createTestApp, TestAppContext } from '../helpers/test-app';
import { decisionModeRequest, decisionHappyScript } from '../fixtures/decision-mode';

describe('Run Lifecycle (integration)', () => {
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

  it('POST /runs creates a run and returns runId with queued status', async () => {
    const result = await ctx.client.createRun(decisionModeRequest());
    expect(result).toHaveProperty('runId');
    expect(result.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(result.status).toBe('queued');
  });

  it('GET /runs/:id fetches the run record', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());

    // Small delay for async processing
    await sleep(200);

    const run = await ctx.client.getRun(runId);
    expect(run).toHaveProperty('id', runId);
    expect(run).toHaveProperty('status');
    expect(run).toHaveProperty('runtimeKind', 'scripted-mock');
    expect(run).toHaveProperty('createdAt');
  });

  it('GET /runs lists runs with pagination', async () => {
    // Create 3 runs
    await ctx.client.createRun(decisionModeRequest());
    await ctx.client.createRun(decisionModeRequest());
    await ctx.client.createRun(decisionModeRequest());

    await sleep(200);

    const result = await ctx.client.listRuns({ limit: 2 }) as any;
    expect(result.data).toBeDefined();
    expect(result.data.length).toBeLessThanOrEqual(2);
    expect(result).toHaveProperty('total');
  });

  it('GET /runs supports filtering by tags', async () => {
    await ctx.client.createRun(
      decisionModeRequest({
        execution: { tags: ['special-tag'] }
      })
    );
    await ctx.client.createRun(decisionModeRequest());

    await sleep(200);

    // Test fixture uses sandbox mode; includeSandbox required to see sandbox runs in listing
    const result = await ctx.client.listRuns({ tags: 'special-tag', includeSandbox: true }) as any;
    expect(result.data).toBeDefined();
    const tagged = result.data.filter(
      (r: any) => r.tags && r.tags.includes('special-tag')
    );
    expect(tagged.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /runs/:id/state returns the projected state', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());

    // Wait for run to start processing
    await sleep(500);

    const state = await ctx.client.getState(runId);
    expect(state).toHaveProperty('run');
    expect(state).toHaveProperty('participants');
    expect(state).toHaveProperty('graph');
    expect(state).toHaveProperty('decision');
    expect(state).toHaveProperty('signals');
    expect(state).toHaveProperty('progress');
    expect(state).toHaveProperty('timeline');
  });

  it('run transitions through lifecycle states', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());

    // Initial state should be queued
    const initial = await ctx.client.getRun(runId);
    expect(['queued', 'starting', 'binding_session', 'running']).toContain(
      (initial as any).status
    );

    // Wait for async execution to progress
    await sleep(1000);

    const later = await ctx.client.getRun(runId);
    // Should have progressed past queued
    expect(
      ['starting', 'binding_session', 'running', 'completed', 'failed']
    ).toContain((later as any).status);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
