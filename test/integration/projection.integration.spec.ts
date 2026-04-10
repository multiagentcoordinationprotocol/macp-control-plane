import { createTestApp, TestAppContext } from '../helpers/test-app';
import {
  decisionModeRequest as decisionModeRequestBase,
  decisionHappyScript
} from '../fixtures/decision-mode';

const isRealRuntime =
  process.env.INTEGRATION_RUNTIME === 'docker' ||
  process.env.INTEGRATION_RUNTIME === 'remote';

/** Returns the execution request, adjusting for the active runtime mode */
function decisionModeRequest(overrides?: Record<string, unknown>) {
  const base = decisionModeRequestBase(overrides as any);
  if (isRealRuntime) {
    base.runtime = { kind: 'rust' };
    // Real runtime requires proto-encoded kickoff payloads
    if (base.kickoff) {
      for (const k of base.kickoff) {
        if (k.payload && !k.payloadEnvelope) {
          k.payloadEnvelope = {
            encoding: 'proto' as const,
            proto: {
              typeName: 'macp.modes.decision.v1.ProposalPayload',
              value: k.payload
            }
          };
          delete k.payload;
        }
      }
    }
  }
  return base;
}

/**
 * Build a message body with proto encoding when running against the real runtime.
 */
function msg(
  from: string,
  messageType: string,
  protoTypeName: string,
  payload: Record<string, unknown>,
  to?: string[]
): Record<string, unknown> {
  const base: Record<string, unknown> = { from, messageType };
  if (to) base.to = to;

  if (isRealRuntime) {
    base.payloadEnvelope = {
      encoding: 'proto',
      proto: { typeName: protoTypeName, value: payload }
    };
  } else {
    base.payload = payload;
  }
  return base;
}

describe('Projection (integration)', () => {
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

  it('projection includes all required sections', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());
    await sleep(500);

    const state = await ctx.client.getState(runId) as any;

    expect(state).toHaveProperty('run');
    expect(state).toHaveProperty('participants');
    expect(state).toHaveProperty('graph');
    expect(state).toHaveProperty('decision');
    expect(state).toHaveProperty('signals');
    expect(state).toHaveProperty('progress');
    expect(state).toHaveProperty('timeline');
    expect(state).toHaveProperty('trace');
    expect(state).toHaveProperty('outboundMessages');
  });

  it('projection tracks participant status', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());
    await sleep(1000);

    const state = await ctx.client.getState(runId) as any;
    expect(state.participants).toBeDefined();
    expect(state.participants).toBeInstanceOf(Array);
    // Should have participants from the execution request
    if (state.participants.length > 0) {
      const participant = state.participants[0];
      expect(participant).toHaveProperty('participantId');
      expect(participant).toHaveProperty('status');
    }
  });

  it('projection tracks timeline with sequence numbers', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());
    await sleep(1500);

    const state = await ctx.client.getState(runId) as any;
    expect(state.timeline).toBeDefined();
    expect(state.timeline).toHaveProperty('latestSeq');
    expect(state.timeline).toHaveProperty('totalEvents');
    expect(state.timeline.totalEvents).toBeGreaterThanOrEqual(0);
  });

  it('projection graph tracks message flow', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());
    await sleep(1000);

    // Send a message to create a graph edge
    await ctx.client.sendMessage(
      runId,
      msg('evaluator', 'Evaluation', 'macp.modes.decision.v1.EvaluationPayload', {
        proposalId: 'prop-1',
        recommendation: 'APPROVE',
        confidence: 0.9,
        reason: 'Approved'
      }, ['proposer'])
    );
    await sleep(1000);

    const state = await ctx.client.getState(runId) as any;
    expect(state.graph).toBeDefined();
    expect(state.graph).toHaveProperty('nodes');
    expect(state.graph).toHaveProperty('edges');
  });

  it('projection rebuilds from events', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());

    // Wait for run to fully settle (all events processed)
    let settled = false;
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      const run = await ctx.client.getRun(runId) as any;
      if (['completed', 'failed'].includes(run.status)) { settled = true; break; }
    }

    // Get state before rebuild
    const before = await ctx.client.getState(runId) as any;
    expect(before.run).toBeDefined();

    // Trigger projection rebuild
    await ctx.client.rebuildProjection(runId);
    await sleep(500);

    // Get state after rebuild — core identity should be the same
    const after = await ctx.client.getState(runId) as any;
    expect(after.run.runId).toBe(before.run.runId);
    expect(after.run.status).toBe(before.run.status);
    // Event count should be >= before (events may still trickle in)
    expect(after.timeline.totalEvents).toBeGreaterThanOrEqual(before.timeline.totalEvents);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
