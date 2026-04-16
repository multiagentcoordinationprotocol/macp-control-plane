import { createTestApp, TestAppContext } from '../helpers/test-app';
import { decisionModeRequest, decisionHappyScript } from '../fixtures/decision-mode';
import { waitFor } from '../helpers/wait-for';

/**
 * Observer-mode cancel flow (direct-agent-auth CP-8).
 *
 * Default (Option A): control-plane POSTs to initiator agent's cancelCallback.
 * Opt-in (Option B): metadata.cancellationDelegated=true lets control-plane call CancelSession directly.
 */
describe('Run Cancellation (integration, observer mode)', () => {
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

  it('rejects cancel when neither cancelCallback nor delegation is configured (Option A/B unmet)', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());
    // Wait until the run record exists, then confirm cancel is rejected.
    await waitFor(
      async () => {
        const r = (await ctx.client.getRun(runId)) as any;
        return r.id === runId ? r : null;
      },
      { timeoutMs: 3000, label: 'run visible' },
    );

    const result = (await ctx.client.cancelRun(runId)) as any;
    expect(result.statusCode ?? 0).toBeGreaterThanOrEqual(400);
  });

  it('Option B: cancels when metadata.cancellationDelegated=true', async () => {
    const request = decisionModeRequest({
      session: {
        ...decisionModeRequest().session,
        metadata: { cancellationDelegated: true },
      },
    });
    const { runId } = await ctx.client.createRun(request);

    await waitFor(
      async () => {
        const r = (await ctx.client.getRun(runId)) as any;
        return ['binding_session', 'running', 'completed'].includes(r.status) ? r : null;
      },
      { timeoutMs: 5000, label: 'run bound' },
    );

    const result = (await ctx.client.cancelRun(runId, 'integration test cancel')) as any;
    expect(result.statusCode).toBeUndefined();

    const terminal = await waitFor(
      async () => {
        const r = (await ctx.client.getRun(runId)) as any;
        return ['cancelled', 'completed'].includes(r.status) ? r : null;
      },
      { timeoutMs: 3000, label: 'run terminal after cancel' },
    );
    expect(['cancelled', 'completed']).toContain(terminal.status);
  });

  it('cancel of non-existent run returns error', async () => {
    const result = (await ctx.client.cancelRun(
      '00000000-0000-0000-0000-000000000000',
    )) as any;
    expect(result.statusCode || result.errorCode).toBeDefined();
  });
});
