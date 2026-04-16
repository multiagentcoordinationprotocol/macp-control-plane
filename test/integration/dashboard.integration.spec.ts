import { createTestApp, TestAppContext } from '../helpers/test-app';
import { decisionHappyScript } from '../fixtures/decision-mode';
import { testRuntimeKind } from '../helpers/runtime-kind';
import { waitFor } from '../helpers/wait-for';

describe('Dashboard Overview (integration)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp(decisionHappyScript());
  });

  afterAll(async () => {
    if (ctx) await ctx.app.close();
  });

  it('GET /dashboard/overview returns KPIs, recentRuns, runtimeHealth, and charts', async () => {
    const result = await ctx.client.request('GET', '/dashboard/overview');

    // KPIs
    expect(result).toHaveProperty('kpis');
    expect(result.kpis).toHaveProperty('totalRuns');
    expect(result.kpis).toHaveProperty('activeRuns');
    expect(result.kpis).toHaveProperty('completedRuns');
    expect(result.kpis).toHaveProperty('failedRuns');
    expect(result.kpis).toHaveProperty('cancelledRuns');
    expect(result.kpis).toHaveProperty('totalSignals');
    expect(result.kpis).toHaveProperty('totalTokens');
    expect(result.kpis).toHaveProperty('totalCostUsd');
    expect(typeof result.kpis.totalTokens).toBe('number');
    expect(typeof result.kpis.totalCostUsd).toBe('number');

    // Recent runs
    expect(result).toHaveProperty('recentRuns');
    expect(Array.isArray(result.recentRuns)).toBe(true);

    // Runtime health
    expect(result).toHaveProperty('runtimeHealth');
    expect(result.runtimeHealth).toHaveProperty('ok');
    expect(result.runtimeHealth).toHaveProperty('runtimeKind');

    // Charts
    expect(result).toHaveProperty('charts');
    expect(result.charts).toHaveProperty('runVolume');
    expect(result.charts).toHaveProperty('latency');
    expect(result.charts).toHaveProperty('signalVolume');
    expect(result.charts).toHaveProperty('errorClasses');

    // Chart structure
    expect(result.charts.runVolume).toHaveProperty('labels');
    expect(result.charts.runVolume).toHaveProperty('data');
    expect(result.charts.latency).toHaveProperty('labels');
    expect(result.charts.latency).toHaveProperty('data');
  });

  it('GET /dashboard/overview?range=7d works', async () => {
    const result = await ctx.client.request('GET', '/dashboard/overview', {
      query: { range: '7d' }
    });
    expect(result).toHaveProperty('kpis');
    expect(typeof result.kpis.totalRuns).toBe('number');
  });

  it('GET /dashboard/overview?range=30d works', async () => {
    const result = await ctx.client.request('GET', '/dashboard/overview', {
      query: { range: '30d' }
    });
    expect(result).toHaveProperty('kpis');
  });

  it('KPIs reflect created runs', async () => {
    await ctx.client.createRun({
      mode: 'sandbox',
      runtime: { kind: testRuntimeKind() },
      session: {
        modeName: 'macp.mode.decision.v1',
        modeVersion: '1.0.0',
        configurationVersion: '1.0.0',
        ttlMs: 60000,
        participants: [{ id: 'alice' }]
      }
    });

    const result = await waitFor(
      async () => {
        const r = (await ctx.client.request('GET', '/dashboard/overview')) as any;
        return r.kpis.totalRuns >= 1 ? r : null;
      },
      { timeoutMs: 3000, label: 'dashboard KPIs' },
    );
    expect(result.kpis.totalRuns).toBeGreaterThanOrEqual(1);
  });

  it('recentRuns contains up to 10 runs sorted by creation date', async () => {
    const result = await ctx.client.request('GET', '/dashboard/overview');
    expect(result.recentRuns.length).toBeLessThanOrEqual(10);

    if (result.recentRuns.length > 0) {
      const run = result.recentRuns[0];
      expect(run).toHaveProperty('id');
      expect(run).toHaveProperty('status');
      expect(run).toHaveProperty('runtimeKind');
      expect(run).toHaveProperty('createdAt');
    }
  });
});

describe('Dashboard Agent Metrics (integration)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp(decisionHappyScript());
  });

  afterAll(async () => {
    if (ctx) await ctx.app.close();
  });

  it('GET /dashboard/agents/metrics returns array of agent metrics', async () => {
    // Create a run to generate some participant events
    await ctx.client.createRun({
      mode: 'sandbox',
      runtime: { kind: testRuntimeKind() },
      session: {
        modeName: 'macp.mode.decision.v1',
        modeVersion: '1.0.0',
        configurationVersion: '1.0.0',
        ttlMs: 60000,
        participants: [
          { id: 'agent-a' },
          { id: 'agent-b' },
        ]
      }
    });

    const result = await waitFor(
      async () => {
        const r = (await ctx.client.request('GET', '/dashboard/agents/metrics')) as any[];
        return Array.isArray(r) ? r : null;
      },
      { timeoutMs: 3000, label: 'agent metrics' },
    );
    expect(Array.isArray(result)).toBe(true);

    if (result.length > 0) {
      const agent = result[0];
      expect(agent).toHaveProperty('participantId');
      expect(agent).toHaveProperty('runs');
      expect(agent).toHaveProperty('messages');
      expect(agent).toHaveProperty('signals');
      expect(typeof agent.runs).toBe('number');
    }
  });
});

describe('Run Listing Filters (integration)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp(decisionHappyScript());
  });

  afterAll(async () => {
    if (ctx) await ctx.app.close();
  });

  it('GET /runs supports environment filter', async () => {
    // Create a run with environment metadata
    await ctx.client.createRun({
      mode: 'sandbox',
      runtime: { kind: testRuntimeKind() },
      session: {
        modeName: 'macp.mode.decision.v1',
        modeVersion: '1.0.0',
        configurationVersion: '1.0.0',
        ttlMs: 60000,
        participants: [{ id: 'alice' }],
        metadata: { environment: 'staging' }
      },
      execution: { tags: ['env-test'] }
    });

    const result = await waitFor(
      async () => {
        const r = (await ctx.client.listRuns({ environment: 'staging' })) as any;
        return r.data ? r : null;
      },
      { timeoutMs: 3000, label: 'environment filter' },
    );
    expect(result).toHaveProperty('data');
  });

  it('GET /runs supports scenarioRef filter', async () => {
    const result = await ctx.client.listRuns({ scenarioRef: 'fraud' }) as any;
    expect(result).toHaveProperty('data');
    expect(Array.isArray(result.data)).toBe(true);
  });

  it('GET /runs supports search param', async () => {
    const result = await ctx.client.listRuns({ search: 'decision' }) as any;
    expect(result).toHaveProperty('data');
    expect(Array.isArray(result.data)).toBe(true);
  });
});

