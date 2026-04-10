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
 * The real Rust runtime requires proto-encoded payloads, while the mock accepts JSON.
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
    // Real runtime: proto-encoded via payloadEnvelope
    base.payloadEnvelope = {
      encoding: 'proto',
      proto: { typeName: protoTypeName, value: payload }
    };
  } else {
    // Mock runtime: plain JSON
    base.payload = payload;
  }
  return base;
}

describe('Run Messaging (integration)', () => {
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

  it('sends a message with JSON payload and receives ack', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());
    await sleep(500);

    const result = await ctx.client.sendMessage(
      runId,
      msg('evaluator', 'Evaluation', 'macp.modes.decision.v1.EvaluationPayload', {
        proposalId: 'prop-1',
        recommendation: 'APPROVE',
        confidence: 0.9,
        reason: 'Looks good'
      }, ['proposer'])
    );

    expect(result).toHaveProperty('messageId');
    expect(result).toHaveProperty('ack');
    expect(result.ack).toHaveProperty('ok', true);
  });

  it('persists message.sent canonical event', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());
    await sleep(500);

    await ctx.client.sendMessage(
      runId,
      msg('evaluator', 'Evaluation', 'macp.modes.decision.v1.EvaluationPayload', {
        proposalId: 'prop-1',
        recommendation: 'APPROVE',
        confidence: 0.9,
        reason: 'Approved'
      }, ['proposer'])
    );

    await sleep(500);

    const events = await ctx.client.listEvents(runId) as any[];
    const sentEvents = events.filter((e: any) => e.type === 'message.sent');
    expect(sentEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('sends a signal', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());
    await sleep(500);

    const result = await ctx.client.sendSignal(runId, {
      from: 'proposer',
      messageType: 'Signal',
      signalType: 'attention',
      payload: { signalType: 'attention', data: 'Urgent review needed' }
    });

    expect(result).toBeDefined();
  });

  it('updates context during session', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());
    await sleep(500);

    const result = await ctx.client.updateContext(runId, {
      from: 'proposer',
      context: { additionalData: 'new context information' }
    });

    expect(result).toBeDefined();
  });

  it('rejects message to non-existent run', async () => {
    const result = await ctx.client.sendMessage(
      '00000000-0000-0000-0000-000000000000',
      msg('evaluator', 'Evaluation', 'macp.modes.decision.v1.EvaluationPayload', {
        proposalId: 'prop-1',
        recommendation: 'APPROVE',
        confidence: 0.9,
        reason: 'Test'
      })
    ) as any;

    // Should return an error
    expect(result.statusCode || result.errorCode).toBeDefined();
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
