import { createTestApp, TestAppContext } from '../helpers/test-app';
import { decisionModeRequest, decisionHappyScript, decisionSlowScript } from '../fixtures/decision-mode';
import { AppException } from '../../src/errors/app-exception';
import { ErrorCode } from '../../src/errors/error-codes';
import { waitFor } from '../helpers/wait-for';
import { isRealRuntime } from '../helpers/real-runtime-gate';

// Mock-only: these depend on events the ScriptedMockRuntimeProvider scripts. A real
// runtime (INTEGRATION_RUNTIME=docker|remote) has no agents to emit them, so the run
// never binds or completes; skip there rather than time out.
const itMock = isRealRuntime ? it.skip : it;

/**
 * Observer-mode cancel flow (direct-agent-auth CP-8).
 *
 * Default (Option A): control-plane POSTs to initiator agent's cancelCallback.
 * Opt-in (Option B): metadata.cancellationDelegated=true lets control-plane call CancelSession directly.
 *
 * Either way the run is marked cancelled only after the runtime (or callback) accepts. A refused
 * CancelSession surfaces the mapped runtime error and leaves the run running — the control plane
 * must never show `cancelled` for a session the runtime still holds OPEN.
 */
describe('Run Cancellation (integration, observer mode)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp(decisionHappyScript());
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  // Commitment lands only after 60s, so a run stays `running` for the whole test instead of
  // racing the cancel to `completed`.
  const NEVER_DURING_TEST_MS = 60000;

  beforeEach(async () => {
    await ctx.cleanup();
    ctx.mockRuntime?.setScript(decisionHappyScript());
  });

  function delegatedRequest() {
    return decisionModeRequest({
      session: {
        ...decisionModeRequest().session,
        metadata: { cancellationDelegated: true },
      },
    });
  }

  async function waitRunning(runId: string): Promise<void> {
    await waitFor(
      async () => {
        const r = (await ctx.client.getRun(runId)) as any;
        return r.status === 'running' ? r : null;
      },
      { timeoutMs: 5000, label: 'run running' },
    );
  }

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

  itMock('Option B: cancels when metadata.cancellationDelegated=true and the runtime accepts', async () => {
    ctx.mockRuntime.setScript(decisionSlowScript(NEVER_DURING_TEST_MS));
    const { runId } = await ctx.client.createRun(delegatedRequest());
    await waitRunning(runId);

    const result = (await ctx.client.cancelRun(runId, 'integration test cancel')) as any;
    expect(result.statusCode).toBeUndefined();
    expect(result.status).toBe('cancelled');

    const run = (await ctx.client.getRun(runId)) as any;
    expect(run.status).toBe('cancelled');
    // The runtime itself accepted the cancel — not just a local status flip.
    const snapshot = await ctx.mockRuntime.getSession({ runId, runtimeSessionId: run.runtimeSessionId });
    expect(snapshot.state).toBe('SESSION_STATE_CANCELLED');
  });

  itMock('Option B: a runtime refusal (403 FORBIDDEN) surfaces and leaves the run running', async () => {
    ctx.mockRuntime.setScript({
      ...decisionSlowScript(NEVER_DURING_TEST_MS),
      controlRefusals: {
        cancel: new AppException(
          ErrorCode.FORBIDDEN,
          'only the session initiator or policy-delegated roles can cancel',
          403,
        ),
      },
    });
    const { runId } = await ctx.client.createRun(delegatedRequest());
    await waitRunning(runId);

    const res = await ctx.client.requestNoAuth('POST', `/runs/${runId}/cancel`, {
      headers: { Authorization: 'Bearer test-key-integration' },
      body: { reason: 'not delegated' },
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errorCode: 'FORBIDDEN' });

    const run = (await ctx.client.getRun(runId)) as any;
    expect(run.status).toBe('running');
    const events = (await ctx.client.listEvents(runId)) as any[];
    expect(events.some((ev) => ev.type === 'run.cancelled')).toBe(false);
  });

  it('cancel of non-existent run returns error', async () => {
    const result = (await ctx.client.cancelRun(
      '00000000-0000-0000-0000-000000000000',
    )) as any;
    expect(result.statusCode || result.errorCode).toBeDefined();
  });
});
