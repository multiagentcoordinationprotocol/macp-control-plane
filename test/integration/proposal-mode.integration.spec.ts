import { createTestApp, TestAppContext } from '../helpers/test-app';
import {
  proposalModeRequest as proposalModeRequestBase,
  proposalAcceptScript,
  proposalCounterScript,
  proposalRejectScript
} from '../fixtures/proposal-mode';

const isRealRuntime =
  process.env.INTEGRATION_RUNTIME === 'docker' ||
  process.env.INTEGRATION_RUNTIME === 'remote';

/** Returns the execution request, adjusting for the active runtime mode */
function proposalModeRequest(overrides?: Record<string, unknown>) {
  const base = proposalModeRequestBase(overrides as any);
  if (isRealRuntime) {
    base.runtime = { kind: 'rust' };
    // Real runtime requires proto-encoded kickoff payloads
    if (base.kickoff) {
      for (const k of base.kickoff) {
        if (k.payload && !k.payloadEnvelope) {
          k.payloadEnvelope = {
            encoding: 'proto' as const,
            proto: {
              typeName: 'macp.modes.proposal.v1.ProposalPayload',
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

describe('Proposal Mode (integration)', () => {
  let ctx: TestAppContext;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  afterAll(async () => {
    if (ctx) await ctx.app.close();
  });

  describe('Accept Flow', () => {
    beforeAll(async () => {
      ctx = await createTestApp(isRealRuntime ? undefined : proposalAcceptScript());
    });

    it('reviewer accepts proposal', async () => {
      const { runId } = await ctx.client.createRun(proposalModeRequest());
      await sleep(500);

      await ctx.client.sendMessage(
        runId,
        msg('reviewer', 'Accept', 'macp.modes.proposal.v1.AcceptPayload', {
          proposalId: 'prop-1',
          comment: 'LGTM'
        }, ['author'])
      );

      await sleep(1000);

      const run = await ctx.client.getRun(runId) as any;
      expect(['running', 'completed']).toContain(run.status);

      const events = await ctx.client.listEvents(runId) as any[];
      const sentEvents = events.filter((e: any) => e.type === 'message.sent');
      expect(sentEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Counter-Proposal Flow', () => {
    beforeAll(async () => {
      if (ctx) await ctx.app.close();
      ctx = await createTestApp(isRealRuntime ? undefined : proposalCounterScript());
    });

    it('reviewer counter-proposes, author accepts', async () => {
      const { runId } = await ctx.client.createRun(proposalModeRequest());
      await sleep(500);

      // Reviewer sends counter-proposal
      await ctx.client.sendMessage(
        runId,
        msg('reviewer', 'CounterProposal', 'macp.modes.proposal.v1.CounterProposalPayload', {
          proposalId: 'prop-2',
          supersedesProposalId: 'prop-1',
          title: 'Better approach'
        }, ['author'])
      );
      await sleep(200);

      // Author accepts the counter-proposal
      await ctx.client.sendMessage(
        runId,
        msg('author', 'Accept', 'macp.modes.proposal.v1.AcceptPayload', {
          proposalId: 'prop-2'
        }, ['reviewer'])
      );

      await sleep(1000);

      const events = await ctx.client.listEvents(runId) as any[];
      const sentEvents = events.filter((e: any) => e.type === 'message.sent');
      expect(sentEvents.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Rejection Flow', () => {
    beforeAll(async () => {
      if (ctx) await ctx.app.close();
      ctx = await createTestApp(isRealRuntime ? undefined : proposalRejectScript());
    });

    it('reviewer rejects proposal', async () => {
      const { runId } = await ctx.client.createRun(proposalModeRequest());
      await sleep(500);

      await ctx.client.sendMessage(
        runId,
        msg('reviewer', 'Reject', 'macp.modes.proposal.v1.RejectPayload', {
          proposalId: 'prop-1',
          reason: 'Out of scope',
          terminal: true
        }, ['author'])
      );

      await sleep(1000);

      const run = await ctx.client.getRun(runId) as any;
      expect(['running', 'completed', 'failed']).toContain(run.status);
    });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
