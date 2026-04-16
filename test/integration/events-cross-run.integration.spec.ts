import { createTestApp, TestAppContext } from '../helpers/test-app';
import { decisionModeRequest, decisionHappyScript } from '../fixtures/decision-mode';
import { waitFor } from '../helpers/wait-for';

describe('Cross-run events endpoint (§4.1 integration)', () => {
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

  async function httpGet(path: string) {
    return (ctx.client as any).request('GET', path);
  }

  it('GET /events returns { data, total, limit, nextCursor } shape', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());

    const body = await waitFor(
      async () => {
        const b: any = await httpGet(`/events?runId=${runId}&limit=100`);
        return b.total >= 1 ? b : null;
      },
      { timeoutMs: 5000, label: 'events appeared' },
    );

    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('limit');
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.limit).toBe(100);
  });

  it('GET /events filters by type (§4.1)', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());

    const body = await waitFor(
      async () => {
        const b: any = await httpGet(`/events?runId=${runId}&type=run.created,run.started`);
        return b.data.length >= 1 ? b : null;
      },
      { timeoutMs: 5000, label: 'run.created/started events' },
    );

    for (const event of body.data) {
      expect(['run.created', 'run.started']).toContain(event.type);
    }
  });

  it('GET /runs/:id/events with time range returns filtered shape (§4.2)', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());
    const future = new Date(Date.now() + 60_000).toISOString();

    const body = await waitFor(
      async () => {
        const b: any = await httpGet(
          `/runs/${runId}/events?beforeTs=${encodeURIComponent(future)}&limit=50`,
        );
        return b?.data && b.total >= 1 ? b : null;
      },
      { timeoutMs: 5000, label: 'filtered events' },
    );

    expect(body).toHaveProperty('data');
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('limit');
  });

  it('GET /runs/:id/events with no filter keeps legacy array shape (backward compat)', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());

    const body = await waitFor(
      async () => {
        const b: any = await httpGet(`/runs/${runId}/events?limit=50`);
        return Array.isArray(b) && b.length >= 1 ? b : null;
      },
      { timeoutMs: 5000, label: 'legacy array events' },
    );

    expect(Array.isArray(body)).toBe(true);
  });
});
