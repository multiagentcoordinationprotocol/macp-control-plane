import { createTestApp, TestAppContext } from '../helpers/test-app';
import { decisionModeRequest, decisionHappyScript } from '../fixtures/decision-mode';
import { waitFor } from '../helpers/wait-for';
import { isRealRuntime } from '../helpers/real-runtime-gate';

/**
 * Issue #100: a session that already RESOLVED before the observer attached is a
 * success. The run binds, skips the (compacted, nothing-live) subscribe, and
 * completes through the GetSession poll path — it is not failed with a 409.
 * Mock-only: it scripts the runtime's GetSession state.
 */
const describeMock = isRealRuntime ? describe.skip : describe;

describeMock('Already-RESOLVED session at attach (integration, mock runtime)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp(decisionHappyScript());
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await ctx.cleanup();
    ctx.mockRuntime.setScript(decisionHappyScript());
  });

  it('completes the run instead of failing it when GetSession already reports RESOLVED', async () => {
    ctx.mockRuntime.setSessionState('SESSION_STATE_RESOLVED');

    const { runId } = await ctx.client.createRun(decisionModeRequest());

    const terminal = await waitFor(
      async () => {
        const r = (await ctx.client.getRun(runId)) as any;
        return ['completed', 'failed', 'cancelled'].includes(r.status) ? r : null;
      },
      { timeoutMs: 15000, label: 'run terminal' }
    );
    expect(terminal.status).toBe('completed');
    expect(terminal.errorCode).toBeFalsy();

    const events = (await ctx.client.listEvents(runId)) as any[];
    const states = events.filter((e) => e.type === 'session.state.changed').map((e) => e.data.state);
    expect(states).not.toContain('SESSION_STATE_OPEN');
    expect(states).toContain('SESSION_STATE_RESOLVED');
  });

  it('still fails a session that was CANCELLED before the observer attached', async () => {
    ctx.mockRuntime.setSessionState('SESSION_STATE_CANCELLED');

    const { runId } = await ctx.client.createRun(decisionModeRequest());

    const terminal = await waitFor(
      async () => {
        const r = (await ctx.client.getRun(runId)) as any;
        return ['completed', 'failed', 'cancelled'].includes(r.status) ? r : null;
      },
      { timeoutMs: 15000, label: 'run terminal' }
    );
    expect(terminal.status).toBe('failed');
  });
});
