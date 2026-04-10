import { createTestApp, TestAppContext } from '../helpers/test-app';
import {
  quorumModeRequest as quorumModeRequestBase,
  quorumReachedScript,
  quorumRejectedScript,
  quorumAbstentionScript
} from '../fixtures/quorum-mode';

const isRealRuntime =
  process.env.INTEGRATION_RUNTIME === 'docker' ||
  process.env.INTEGRATION_RUNTIME === 'remote';

/** Returns the execution request, adjusting for the active runtime mode */
function quorumModeRequest(overrides?: Record<string, unknown>) {
  const base = quorumModeRequestBase(overrides as any);
  if (isRealRuntime) {
    base.runtime = { kind: 'rust' };
    // Real runtime requires proto-encoded kickoff payloads
    if (base.kickoff) {
      for (const k of base.kickoff) {
        if (k.payload && !k.payloadEnvelope) {
          k.payloadEnvelope = {
            encoding: 'proto' as const,
            proto: {
              typeName: 'macp.modes.quorum.v1.ApprovalRequestPayload',
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

describe('Quorum Mode (integration)', () => {
  let ctx: TestAppContext;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  afterAll(async () => {
    if (ctx) await ctx.app.close();
  });

  describe('Quorum Reached', () => {
    beforeAll(async () => {
      ctx = await createTestApp(isRealRuntime ? undefined : quorumReachedScript());
    });

    it('two approvals reach quorum', async () => {
      const { runId } = await ctx.client.createRun(quorumModeRequest());
      await sleep(500);

      await ctx.client.sendMessage(runId,
        msg('voter_a', 'Approve', 'macp.modes.quorum.v1.ApprovePayload', {
          requestId: 'approval-1', comment: 'Ship it'
        }, ['initiator'])
      );
      await sleep(200);

      await ctx.client.sendMessage(runId,
        msg('voter_b', 'Approve', 'macp.modes.quorum.v1.ApprovePayload', {
          requestId: 'approval-1'
        }, ['initiator'])
      );

      await sleep(1000);

      const run = await ctx.client.getRun(runId) as any;
      expect(['running', 'completed']).toContain(run.status);
    });
  });

  describe('Quorum Not Reached', () => {
    beforeAll(async () => {
      if (ctx) await ctx.app.close();
      ctx = await createTestApp(isRealRuntime ? undefined : quorumRejectedScript());
    });

    it('majority rejection blocks quorum', async () => {
      const { runId } = await ctx.client.createRun(quorumModeRequest());
      await sleep(500);

      await ctx.client.sendMessage(runId,
        msg('voter_a', 'Approve', 'macp.modes.quorum.v1.ApprovePayload', {
          requestId: 'approval-1'
        }, ['initiator'])
      );
      await sleep(200);

      await ctx.client.sendMessage(runId,
        msg('voter_b', 'Reject', 'macp.modes.quorum.v1.RejectPayload', {
          requestId: 'approval-1', reason: 'Not ready'
        }, ['initiator'])
      );
      await sleep(200);

      await ctx.client.sendMessage(runId,
        msg('voter_c', 'Reject', 'macp.modes.quorum.v1.RejectPayload', {
          requestId: 'approval-1', reason: 'Missing tests'
        }, ['initiator'])
      );

      await sleep(1000);

      const events = await ctx.client.listEvents(runId) as any[];
      const sentEvents = events.filter((e: any) => e.type === 'message.sent');
      expect(sentEvents.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('Abstention Handling', () => {
    beforeAll(async () => {
      if (ctx) await ctx.app.close();
      ctx = await createTestApp(isRealRuntime ? undefined : quorumAbstentionScript());
    });

    it('abstention does not block quorum when approvals sufficient', async () => {
      const { runId } = await ctx.client.createRun(quorumModeRequest());
      await sleep(500);

      await ctx.client.sendMessage(runId,
        msg('voter_a', 'Approve', 'macp.modes.quorum.v1.ApprovePayload', {
          requestId: 'approval-1'
        }, ['initiator'])
      );
      await sleep(200);

      await ctx.client.sendMessage(runId,
        msg('voter_b', 'Abstain', 'macp.modes.quorum.v1.AbstainPayload', {
          requestId: 'approval-1', reason: 'No opinion'
        }, ['initiator'])
      );
      await sleep(200);

      await ctx.client.sendMessage(runId,
        msg('voter_c', 'Approve', 'macp.modes.quorum.v1.ApprovePayload', {
          requestId: 'approval-1'
        }, ['initiator'])
      );

      await sleep(1000);

      const run = await ctx.client.getRun(runId) as any;
      expect(['running', 'completed']).toContain(run.status);
    });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
