import { createTestApp, TestAppContext } from '../helpers/test-app';
import {
  decisionModeRequest as decisionModeRequestBase,
  decisionHappyScript,
} from '../fixtures/decision-mode';

const isRealRuntime =
  process.env.INTEGRATION_RUNTIME === 'docker' ||
  process.env.INTEGRATION_RUNTIME === 'remote';

function decisionModeRequest(overrides?: Record<string, unknown>) {
  const base = decisionModeRequestBase(overrides as any);
  if (isRealRuntime) {
    base.runtime = { kind: 'rust' };
    if (base.kickoff) {
      for (const k of base.kickoff) {
        if (k.payload && !k.payloadEnvelope) {
          k.payloadEnvelope = {
            encoding: 'proto' as const,
            proto: { typeName: 'macp.modes.decision.v1.ProposalPayload', value: k.payload },
          };
          delete k.payload;
        }
      }
    }
  }
  return base;
}

describe('Cross-run events endpoint (§4.1 integration)', () => {
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

  async function httpGet(path: string) {
    return (ctx.client as any).request('GET', path);
  }

  it('GET /events returns { data, total, limit, nextCursor } shape', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());
    await sleep(1000);

    const body: any = await httpGet(`/events?runId=${runId}&limit=100`);

    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('limit');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.limit).toBe(100);
    expect(body.total).toBeGreaterThanOrEqual(0);
  });

  it('GET /events filters by type (§4.1)', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());
    await sleep(1200);

    const body: any = await httpGet(`/events?runId=${runId}&type=run.created,run.started`);

    expect(Array.isArray(body.data)).toBe(true);
    for (const event of body.data) {
      expect(['run.created', 'run.started']).toContain(event.type);
    }
  });

  it('GET /runs/:id/events with time range returns filtered shape (§4.2)', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());
    await sleep(1000);

    const future = new Date(Date.now() + 60_000).toISOString();
    const body: any = await httpGet(`/runs/${runId}/events?beforeTs=${encodeURIComponent(future)}&limit=50`);

    // When filtered, response shape is { data, total, limit, nextCursor }
    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('limit');
  });

  it('GET /runs/:id/events with no filter keeps legacy array shape (backward compat)', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());
    await sleep(800);

    const body: any = await httpGet(`/runs/${runId}/events?limit=50`);

    expect(Array.isArray(body)).toBe(true);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
