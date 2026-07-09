import { createTestApp, TestAppContext } from '../helpers/test-app';
import { decisionModeRequest } from '../fixtures/decision-mode';
import {
  makeStreamEnvelope,
  makeStreamOpened,
  RuntimeScript,
} from '../helpers/scripted-mock-runtime.provider';
import { waitFor } from '../helpers/wait-for';

const isRealRuntime =
  process.env.INTEGRATION_RUNTIME === 'docker' ||
  process.env.INTEGRATION_RUNTIME === 'remote';

/**
 * Stream resume gap (runtime v0.5.0, T7): a FAILED_PRECONDITION (gRPC code 9)
 * on the StreamSession means the resume point was compacted away. The consumer
 * must emit `session.stream.gap`, flag the projection `historyGap`, degrade to
 * the GetSession poll fallback (never resubscribe from 0), and still finalize
 * the run from the polled terminal state.
 */
function gapScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.decision.v1'],
    initiator: 'proposer',
    events: [
      { event: makeStreamOpened() },
      {
        delayMs: 10,
        event: makeStreamEnvelope('macp.mode.decision.v1', 'Proposal', 'proposer', {
          proposalId: 'prop-gap-1',
          option: 'Deploy feature G',
        }),
      },
      {
        delayMs: 10,
        event: makeStreamEnvelope('macp.mode.decision.v1', 'Evaluation', 'evaluator', {
          recommendation: 'APPROVE',
          rationale: 'Looks good',
        }),
      },
      // FAILED_PRECONDITION: resume point compacted away.
      { delayMs: 10, error: { code: 9, message: 'resume point compacted' } },
    ],
  };
}

(isRealRuntime ? describe.skip : describe)('Stream Resume Gap (integration)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp(gapScript());
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await ctx.cleanup();
    ctx.mockRuntime.setScript(gapScript());
  });

  it('emits session.stream.gap, flags historyGap, finalizes completed via poll fallback, and bumps the gap metric', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());

    // Wait for both envelopes to be observed, then let the poll fallback see a
    // RESOLVED session so the run can finalize.
    await waitFor(
      async () => {
        const events = (await ctx.client.listEvents(runId)) as any[];
        return events.filter((e) => e.type === 'message.received').length >= 2 ? events : null;
      },
      { timeoutMs: 5000, label: 'two envelopes observed' },
    );
    ctx.mockRuntime.setSessionState('SESSION_STATE_RESOLVED');

    // session.stream.gap canonical event persisted with the requested resume ordinal.
    const gapEvent = await waitFor(
      async () => {
        const events = (await ctx.client.listEvents(runId)) as any[];
        return events.find((e) => e.type === 'session.stream.gap') ?? null;
      },
      { timeoutMs: 5000, label: 'session.stream.gap event' },
    );
    expect(gapEvent.data.requestedAfter).toBe(2);
    expect(String(gapEvent.data.detail)).toContain('compacted');

    // Run finalizes completed via the poll fallback — never failed.
    const terminal = await waitFor(
      async () => {
        const r = (await ctx.client.getRun(runId)) as any;
        return ['completed', 'failed', 'cancelled'].includes(r.status) ? r : null;
      },
      { timeoutMs: 15000, label: 'run terminal after gap' },
    );
    expect(terminal.status).toBe('completed');

    // Projection flags the incomplete history.
    const state = (await ctx.client.getState(runId)) as any;
    expect(state.run.historyGap).toBe(true);

    // Prometheus counter incremented.
    const metrics = await ctx.client.metrics();
    const match = metrics.match(/^macp_stream_resume_gap_total(?:\{[^}]*\})? (\d+(?:\.\d+)?)$/m);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(1);
  });

  it('does not mark the run failed while degrading to the poll fallback', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());

    await waitFor(
      async () => {
        const events = (await ctx.client.listEvents(runId)) as any[];
        return events.some((e) => e.type === 'session.stream.gap') ? events : null;
      },
      { timeoutMs: 5000, label: 'gap emitted' },
    );

    // Immediately after the gap the run must still be non-terminal (polling).
    const mid = (await ctx.client.getRun(runId)) as any;
    expect(['running', 'suspended']).toContain(mid.status);

    ctx.mockRuntime.setSessionState('SESSION_STATE_RESOLVED');
    const terminal = await waitFor(
      async () => {
        const r = (await ctx.client.getRun(runId)) as any;
        return ['completed', 'failed', 'cancelled'].includes(r.status) ? r : null;
      },
      { timeoutMs: 15000, label: 'run terminal' },
    );
    expect(terminal.status).toBe('completed');
  });
});
