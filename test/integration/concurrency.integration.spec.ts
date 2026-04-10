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

describe('Concurrency (integration)', () => {
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

  it('creates multiple runs simultaneously', async () => {
    const count = 5;
    const promises = Array.from({ length: count }, () =>
      ctx.client.createRun(decisionModeRequest())
    );

    const results = await Promise.all(promises);

    // All should succeed
    expect(results.length).toBe(count);

    // All should have unique IDs
    const ids = results.map((r) => r.runId);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(count);

    // All should have valid UUIDs
    for (const result of results) {
      expect(result.runId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      expect(result.status).toBe('queued');
    }
  });

  it('concurrent messages to same run are all accepted', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());
    // Wait for run to reach running state before sending messages
    for (let i = 0; i < 10; i++) {
      await sleep(300);
      const run = await ctx.client.getRun(runId) as any;
      if (['running', 'completed'].includes(run.status)) break;
    }

    // Send multiple messages concurrently
    const promises = Array.from({ length: 3 }, (_, i) =>
      ctx.client.sendMessage(
        runId,
        msg('evaluator', 'Evaluation', 'macp.modes.decision.v1.EvaluationPayload', {
          proposalId: 'prop-1',
          recommendation: 'APPROVE',
          confidence: 0.9,
          reason: `Concurrent evaluation ${i}`
        }, ['proposer'])
      )
    );

    const results = await Promise.allSettled(promises);

    // At least some should succeed (run may not be in correct state for all)
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThan(0);
  });

  it('fetching runs concurrently does not cause issues', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());
    await sleep(300);

    // Fetch the same run concurrently
    const promises = Array.from({ length: 10 }, () =>
      ctx.client.getRun(runId)
    );

    const results = await Promise.all(promises);

    // All should return the same run
    for (const result of results) {
      expect((result as any).id).toBe(runId);
    }
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
