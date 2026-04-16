import { createTestApp, TestAppContext } from '../helpers/test-app';
import { decisionModeRequest, decisionHappyScript } from '../fixtures/decision-mode';
import { waitFor } from '../helpers/wait-for';

describe('Concurrency (integration, observer mode)', () => {
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

  it('creates multiple runs simultaneously with unique sessionIds', async () => {
    const count = 5;
    const results = await Promise.all(
      Array.from({ length: count }, () => ctx.client.createRun(decisionModeRequest())),
    );

    expect(results.length).toBe(count);

    const runIds = new Set(results.map((r) => r.runId));
    const sessionIds = new Set(results.map((r) => r.sessionId));
    expect(runIds.size).toBe(count);
    expect(sessionIds.size).toBe(count);

    for (const r of results) {
      expect(r.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(r.status).toBe('queued');
    }
  });

  it('fetching the same run concurrently does not cause issues', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());

    await waitFor(
      async () => {
        const r = (await ctx.client.getRun(runId)) as any;
        return r.id === runId ? r : null;
      },
      { timeoutMs: 3000, label: 'run visible' },
    );

    const results = await Promise.all(
      Array.from({ length: 10 }, () => ctx.client.getRun(runId)),
    );
    for (const r of results) {
      expect((r as any).id).toBe(runId);
    }
  });
});
