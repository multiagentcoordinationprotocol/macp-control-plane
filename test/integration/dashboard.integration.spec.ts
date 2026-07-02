import { sql } from 'drizzle-orm';
import { createTestApp, TestAppContext } from '../helpers/test-app';
import { decisionHappyScript } from '../fixtures/decision-mode';
import { testRuntimeKind } from '../helpers/runtime-kind';
import { waitFor } from '../helpers/wait-for';
import { DatabaseService } from '../../src/db/database.service';
import { truncateAll } from '../helpers/test-db';

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

describe('Dashboard Success Rate — negative committed outcomes (integration)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    if (ctx) await ctx.app.close();
  });

  it('excludes negative committed decisions from the success numerator', async () => {
    const db = ctx.module.get(DatabaseService);
    // Clean slate so the aggregate reflects only the two seeded runs.
    await truncateAll(db.pool);

    const positiveRun = '11111111-1111-1111-1111-111111111111';
    const negativeRun = '22222222-2222-2222-2222-222222222222';

    // Two completed decision runs in the same window: one resolved positively,
    // one a negative committed outcome (reject-majority resolved → still 'completed').
    await db.db.execute(sql`
      INSERT INTO runs (id, status, mode, runtime_kind, created_at)
      VALUES
        (${positiveRun}::uuid, 'completed', 'decision', 'rust', now()),
        (${negativeRun}::uuid, 'completed', 'decision', 'rust', now())
    `);

    await db.db.execute(sql`
      INSERT INTO run_events_canonical
        (id, run_id, seq, ts, type, source_kind, source_name, data)
      VALUES
        (${'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'}::uuid, ${positiveRun}::uuid, 1, now(),
         'decision.finalized', 'runtime', 'test',
         ${JSON.stringify({ decodedPayload: { outcome_positive: true } })}::jsonb),
        (${'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'}::uuid, ${negativeRun}::uuid, 1, now(),
         'decision.finalized', 'runtime', 'test',
         ${JSON.stringify({ decodedPayload: { outcome_positive: false } })}::jsonb)
    `);

    const result = (await ctx.client.request('GET', '/dashboard/overview')) as any;

    // 1 positive completed + 1 declined completed, 0 failed/cancelled → 1/2 = 50%.
    // (Without the outcome-awareness the declined run would inflate this to 100%.)
    expect(result.charts.successRate.data).toEqual([50]);
  });

  it('treats a supersede chain by latest-wins (final negative → excluded)', async () => {
    const db = ctx.module.get(DatabaseService);
    await truncateAll(db.pool);

    const run = '33333333-3333-3333-3333-333333333333';
    await db.db.execute(sql`
      INSERT INTO runs (id, status, mode, runtime_kind, created_at)
      VALUES (${run}::uuid, 'completed', 'decision', 'rust', now())
    `);
    // First finalize positive, later superseded by a negative finalize (higher seq).
    await db.db.execute(sql`
      INSERT INTO run_events_canonical
        (id, run_id, seq, ts, type, source_kind, source_name, data)
      VALUES
        (${'cccccccc-cccc-cccc-cccc-cccccccccccc'}::uuid, ${run}::uuid, 1, now(),
         'decision.finalized', 'runtime', 'test',
         ${JSON.stringify({ decodedPayload: { outcome_positive: true } })}::jsonb),
        (${'dddddddd-dddd-dddd-dddd-dddddddddddd'}::uuid, ${run}::uuid, 2, now(),
         'decision.finalized', 'runtime', 'test',
         ${JSON.stringify({ decodedPayload: { outcome_positive: false } })}::jsonb)
    `);

    const result = (await ctx.client.request('GET', '/dashboard/overview')) as any;

    // Latest finalize is negative → the run is declined → excluded from numerator.
    // Sole terminal run → 0/1 = 0%.
    expect(result.charts.successRate.data).toEqual([0]);
  });

  it('counts completed runs with no decision.finalized as successes (COALESCE guard)', async () => {
    const db = ctx.module.get(DatabaseService);
    await truncateAll(db.pool);

    // Non-decision / never-finalized runs have no decision.finalized event, so the
    // LATERAL yields d.negative = NULL. COALESCE(NULL,false)=false must keep them in
    // the numerator — this guards the pre-existing behavior for task/handoff/etc. modes.
    const taskRun = '44444444-4444-4444-4444-444444444444';
    const declinedRun = '55555555-5555-5555-5555-555555555555';
    await db.db.execute(sql`
      INSERT INTO runs (id, status, mode, runtime_kind, created_at)
      VALUES
        (${taskRun}::uuid, 'completed', 'task', 'rust', now()),
        (${declinedRun}::uuid, 'completed', 'decision', 'rust', now())
    `);
    await db.db.execute(sql`
      INSERT INTO run_events_canonical
        (id, run_id, seq, ts, type, source_kind, source_name, data)
      VALUES
        (${'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'}::uuid, ${declinedRun}::uuid, 1, now(),
         'decision.finalized', 'runtime', 'test',
         ${JSON.stringify({ decodedPayload: { outcome_positive: false } })}::jsonb)
    `);

    const result = (await ctx.client.request('GET', '/dashboard/overview')) as any;

    // task run (no finalize → success) + declined decision (excluded) → 1/2 = 50%.
    expect(result.charts.successRate.data).toEqual([50]);
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

