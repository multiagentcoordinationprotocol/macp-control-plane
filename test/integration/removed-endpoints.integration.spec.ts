import { createTestApp, TestAppContext } from '../helpers/test-app';
import { decisionHappyScript, decisionModeRequest } from '../fixtures/decision-mode';

/**
 * End-to-end verification that the envelope-emission endpoints removed in the
 * 2026-04-15 direct-agent-auth refactor continue to return 410 Gone with a
 * stable error-code contract. Complements the controller unit test by exercising
 * the full exception-filter → HTTP wire path.
 */
describe('Removed endpoints (integration)', () => {
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

  const cases: Array<{ path: (runId: string) => string; body: Record<string, unknown> }> = [
    {
      path: (runId) => `/runs/${runId}/messages`,
      body: { from: 'agent-1', messageType: 'Evaluation', payload: {} }
    },
    {
      path: (runId) => `/runs/${runId}/signal`,
      body: { signalType: 'progress.reported', payload: { percent: 10 } }
    },
    {
      path: (runId) => `/runs/${runId}/context`,
      body: { contextUpdate: {} }
    }
  ];

  for (const c of cases) {
    it(`POST ${c.path(':id')} returns 410 with errorCode ENDPOINT_REMOVED`, async () => {
      const { runId } = await ctx.client.createRun(decisionModeRequest());

      const res = await ctx.client.requestNoAuth('POST', c.path(runId), {
        headers: { Authorization: 'Bearer test-key-integration' },
        body: c.body
      });

      expect(res.status).toBe(410);
      const body = res.body as Record<string, unknown>;
      expect(body.statusCode).toBe(410);
      expect(body.errorCode).toBe('ENDPOINT_REMOVED');
      expect(typeof body.message).toBe('string');
      expect(body.message).toMatch(/macp-sdk/);
    });
  }

  it('rejects invalid UUID on removed endpoints before the 410 (ParseUUIDPipe runs first)', async () => {
    const res = await ctx.client.requestNoAuth('POST', '/runs/not-a-uuid/messages', {
      headers: { Authorization: 'Bearer test-key-integration' },
      body: { from: 'agent-1', messageType: 'Evaluation', payload: {} }
    });
    expect(res.status).toBe(400);
  });
});
