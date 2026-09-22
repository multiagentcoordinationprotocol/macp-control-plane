import * as path from 'node:path';
import * as protobuf from 'protobufjs';
import { createTestApp, TestAppContext } from '../helpers/test-app';
import { handoffAcceptScript, handoffImplicitAcceptScript, handoffModeRequest } from '../fixtures/handoff-mode';
import { waitFor } from '../helpers/wait-for';
import { isRealRuntime } from '../helpers/real-runtime-gate';

/**
 * Handoff implicit-accept (runtime v0.8.0, RFC-MACP-0010 §5.1): when a handoff
 * target doesn't respond within `acceptance.implicit_accept_timeout_ms`, the
 * runtime synthesizes its own `HandoffAccept` with `HandoffAcceptPayload.implicit
 * = true`. The control-plane is observer-only and never sees that timeout
 * mechanism — it only ever observes the resulting envelope on the stream — so
 * this spec simulates just the outcome (the synthetic envelope arriving),
 * scripted through the mock runtime, not the timer itself.
 *
 * Existing coverage stops short of proving this end-to-end: unit specs
 * (event-normalizer.service.spec.ts, projection.service.spec.ts) supply
 * `decodedPayload` directly rather than exercising the real proto decoder, and
 * observer-mode.integration.spec.ts's handoff case never asserts `implicit`.
 * The mock runtime's default JSON-payload encoding is not valid input to the
 * real `HandoffAcceptPayload` protobuf decoder, so a naive JSON-only fixture
 * could only ever exercise the message-id-corroboration branch
 * (projection.service.ts:792), never the primary decoded-boolean branch
 * (:791). This spec uses real proto-encoded bytes for the primary-branch case.
 *
 * Gated mock-only (isRealRuntime ? describe.skip : describe), matching the
 * inline ternary pattern other mock-scripting-dependent specs use (e.g.
 * stream-gap.integration.spec.ts) — this depends on ScriptedMockRuntimeProvider
 * scripting, not real-runtime behavior.
 */

async function loadHandoffAcceptPayloadType(): Promise<protobuf.Type> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { protoDir } = require('@multiagentcoordinationprotocol/proto');
  const root = new protobuf.Root();
  root.resolvePath = (_origin: string, target: string) =>
    target.startsWith('/') ? target : path.join(protoDir, target);
  await root.load(['macp/modes/handoff/v1/handoff.proto']);
  return root.lookupType('macp.modes.handoff.v1.HandoffAcceptPayload');
}

function encodeHandoffAcceptPayload(
  type: protobuf.Type,
  fields: { handoffId: string; acceptedBy: string; reason: string; implicit: boolean },
): Buffer {
  const message = type.create(fields);
  return Buffer.from(type.encode(message).finish());
}

(isRealRuntime ? describe.skip : describe)('Handoff implicit-accept (integration, runtime v0.8.0)', () => {
  let ctx: TestAppContext;
  let HandoffAcceptPayload: protobuf.Type;

  beforeAll(async () => {
    HandoffAcceptPayload = await loadHandoffAcceptPayloadType();
    // Placeholder script — every test below sets its own before creating a run.
    ctx = await createTestApp(handoffImplicitAcceptScript({}));
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await ctx.cleanup();
  });

  async function findAcceptContribution(runId: string) {
    return waitFor(
      async () => {
        const state = (await ctx.client.getState(runId)) as any;
        const proposals = state.decision?.current?.proposals as any[] | undefined;
        const accept = proposals?.find((p) => p.participantId === 'target' && p.messageType === 'HandoffAccept');
        return accept ?? null;
      },
      { timeoutMs: 8000, label: 'HandoffAccept contribution in projection' },
    );
  }

  it('badges implicit: true when the decoded HandoffAcceptPayload.implicit is true (primary branch, projection.service.ts:791)', async () => {
    const payloadBytes = encodeHandoffAcceptPayload(HandoffAcceptPayload, {
      handoffId: 'handoff-1',
      acceptedBy: 'target',
      reason: 'no response before the implicit-accept timeout',
      implicit: true,
    });
    // Plain random-UUID messageId (the default from makeStreamEnvelope) — no
    // `implicit-accept:` prefix, so this case can only pass via the decoded
    // payload branch, not the message-id corroboration branch.
    ctx.mockRuntime.setScript(handoffImplicitAcceptScript({ payloadBytes }));

    const { runId } = await ctx.client.createRun(handoffModeRequest());
    const accept = await findAcceptContribution(runId);

    expect(accept.implicit).toBe(true);
  });

  it('badges implicit: true from the implicit-accept: message-id prefix alone when the payload is not a decodable implicit boolean (corroboration branch, projection.service.ts:792)', async () => {
    // A plain JSON payload is not valid protobuf input for HandoffAcceptPayload:
    // decodeKnown's proto decode either throws or "succeeds" on garbage bytes,
    // and either way falls back to (or produces) `{ json: {...}, encoding:
    // 'json' }` — decodedPayload.implicit is undefined either way. This case
    // can only pass via the message-id prefix, not the decoded-payload branch.
    ctx.mockRuntime.setScript(
      handoffImplicitAcceptScript({
        payload: { acceptedAt: new Date().toISOString() },
        messageId: 'implicit-accept:handoff-1',
      }),
    );

    const { runId } = await ctx.client.createRun(handoffModeRequest());
    const accept = await findAcceptContribution(runId);

    expect(accept.implicit).toBe(true);
  });

  it('leaves implicit undefined for a genuine explicit accept (negative control)', async () => {
    // Reuses the existing handoffAcceptScript() directly — the same script the
    // rest of the suite exercises for an ordinary explicit accept — rather than
    // a parameterized variant, so this case proves the negative control against
    // the real explicit-accept fixture, not a lookalike of it.
    ctx.mockRuntime.setScript(handoffAcceptScript());

    const { runId } = await ctx.client.createRun(handoffModeRequest());
    const accept = await findAcceptContribution(runId);

    expect(accept.implicit).toBeUndefined();
  });
});
