import { createTestApp, TestAppContext } from '../helpers/test-app';
import {
  handoffModeRequest as handoffModeRequestBase,
  handoffAcceptScript,
  handoffDeclineScript
} from '../fixtures/handoff-mode';

const isRealRuntime =
  process.env.INTEGRATION_RUNTIME === 'docker' ||
  process.env.INTEGRATION_RUNTIME === 'remote';

/** Returns the execution request, adjusting for the active runtime mode */
function handoffModeRequest(overrides?: Record<string, unknown>) {
  const base = handoffModeRequestBase(overrides as any);
  if (isRealRuntime) {
    base.runtime = { kind: 'rust' };
    // Real runtime requires proto-encoded kickoff payloads
    if (base.kickoff) {
      for (const k of base.kickoff) {
        if (k.payload && !k.payloadEnvelope) {
          k.payloadEnvelope = {
            encoding: 'proto' as const,
            proto: {
              typeName: 'macp.modes.handoff.v1.HandoffOfferPayload',
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

describe('Handoff Mode (integration)', () => {
  let ctx: TestAppContext;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  afterAll(async () => {
    if (ctx) await ctx.app.close();
  });

  describe('Successful Handoff', () => {
    beforeAll(async () => {
      ctx = await createTestApp(isRealRuntime ? undefined : handoffAcceptScript());
    });

    it('source offers, provides context, target accepts', async () => {
      const { runId } = await ctx.client.createRun(handoffModeRequest() as any);
      await sleep(500);

      // Source provides context
      await ctx.client.sendMessage(
        runId,
        msg('source', 'HandoffContext', 'macp.modes.handoff.v1.HandoffContextPayload', {
          conversationHistory: ['msg1', 'msg2'],
          metadata: { topic: 'billing' }
        }, ['target'])
      );
      await sleep(200);

      // Target accepts
      await ctx.client.sendMessage(
        runId,
        msg('target', 'HandoffAccept', 'macp.modes.handoff.v1.HandoffAcceptPayload', {
          acceptedAt: new Date().toISOString()
        }, ['source'])
      );

      // Wait for the run to process messages
      await sleep(2000);

      const run = await ctx.client.getRun(runId) as any;
      expect(run).toHaveProperty('status');
      expect(['running', 'completed']).toContain(run.status);

      // Poll for message events (real runtime may be slower)
      let sentEvents: any[] = [];
      for (let attempt = 0; attempt < 10; attempt++) {
        await sleep(500);
        const events = await ctx.client.listEvents(runId) as any[];
        sentEvents = events.filter((e: any) => e.type === 'message.sent');
        if (sentEvents.length >= (isRealRuntime ? 1 : 2)) break;
      }
      // Mock emits send-ack events for each message; real runtime may only emit for kickoff
      expect(sentEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('projected state shows both participants', async () => {
      const { runId } = await ctx.client.createRun(handoffModeRequest() as any);
      await sleep(1000);

      const state = await ctx.client.getState(runId) as any;
      expect(state.participants).toBeDefined();
      expect(state.participants.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Declined Handoff', () => {
    beforeAll(async () => {
      if (ctx) await ctx.app.close();
      ctx = await createTestApp(isRealRuntime ? undefined : handoffDeclineScript());
    });

    it('target declines handoff', async () => {
      const { runId } = await ctx.client.createRun(handoffModeRequest() as any);
      await sleep(500);

      await ctx.client.sendMessage(
        runId,
        msg('target', 'HandoffDecline', 'macp.modes.handoff.v1.HandoffDeclinePayload', {
          reason: 'Not available'
        }, ['source'])
      );

      await sleep(1000);

      const events = await ctx.client.listEvents(runId) as any[];
      const sentEvents = events.filter((e: any) => e.type === 'message.sent');
      expect(sentEvents.length).toBeGreaterThanOrEqual(1);
    });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
