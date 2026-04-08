import { createTestApp, TestAppContext } from '../helpers/test-app';
import {
  decisionModeRequest as decisionModeRequestBase,
  decisionHappyScript
} from '../fixtures/decision-mode';
import {
  makeStreamEnvelope,
  RuntimeScript
} from '../helpers/scripted-mock-runtime.provider';

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

const isRealRuntime =
  process.env.INTEGRATION_RUNTIME === 'docker' ||
  process.env.INTEGRATION_RUNTIME === 'remote';

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

describe('Decision Mode (integration)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp(isRealRuntime ? undefined : decisionHappyScript());
  });

  afterAll(async () => {
    if (ctx) await ctx.app.close();
  });

  it('creates a decision mode run and reaches running state', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest() as any);
    expect(runId).toBeDefined();

    await sleep(1000);

    const run = (await ctx.client.getRun(runId)) as any;
    expect(['binding_session', 'running', 'completed']).toContain(run.status);
  });

  it('sends Evaluation and Vote — run progresses', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest() as any);
    await sleep(1000);

    // Evaluator sends Evaluation (proto-encoded for real runtime)
    const evalResult = await ctx.client.sendMessage(
      runId,
      msg('evaluator', 'Evaluation', 'macp.modes.decision.v1.EvaluationPayload', {
        proposalId: 'prop-1',
        recommendation: 'APPROVE',
        confidence: 0.95,
        reason: 'Approved for testing'
      }, ['proposer'])
    );
    // Debug: log the full response if ack is missing
    if (!evalResult.ack) {
      console.log('evalResult:', JSON.stringify(evalResult, null, 2));
    }
    expect(evalResult.ack).toBeDefined();

    await sleep(500);

    // Voter sends Vote (proto-encoded for real runtime)
    const voteResult = await ctx.client.sendMessage(
      runId,
      msg('voter', 'Vote', 'macp.modes.decision.v1.VotePayload', {
        proposalId: 'prop-1',
        vote: 'approve',
        reason: 'Looks good'
      }, ['proposer'])
    );
    expect(voteResult.ack).toBeDefined();

    await sleep(1500);

    const run = (await ctx.client.getRun(runId)) as any;
    expect(['running', 'completed']).toContain(run.status);
  });

  it('projected state includes participants, graph, decision, and timeline', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest() as any);
    await sleep(1000);

    const state = (await ctx.client.getState(runId)) as any;
    expect(state.run).toBeDefined();
    expect(state.run.runId).toBe(runId);
    expect(state.run.modeName).toBe('macp.mode.decision.v1');
    expect(state.participants).toBeDefined();
    expect(state.graph).toBeDefined();
    expect(state.graph).toHaveProperty('nodes');
    expect(state.graph).toHaveProperty('edges');
    expect(state.decision).toBeDefined();
    expect(state.timeline).toBeDefined();
    expect(state.timeline.totalEvents).toBeGreaterThanOrEqual(1);
  });

  it('canonical events are persisted with monotonic sequence numbers', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest() as any);

    // Poll until events appear (async pipeline: create -> start -> bind -> persist)
    let events: any[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(500);
      const result = await ctx.client.listEvents(runId);
      events = Array.isArray(result) ? result : (result as any).data ?? [];
      if (events.length > 0) break;
    }
    expect(events.length).toBeGreaterThan(0);

    // Verify monotonically increasing sequence numbers
    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBeGreaterThan(events[i - 1].seq);
    }

    // Should include run.created event
    const runCreated = events.find((e: any) => e.type === 'run.created');
    expect(runCreated).toBeDefined();
  });

  it('handles vote rejection', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest() as any);
    await sleep(1000);

    await ctx.client.sendMessage(
      runId,
      msg('voter', 'Vote', 'macp.modes.decision.v1.VotePayload', {
        proposalId: 'prop-1',
        vote: 'reject',
        reason: 'Insufficient evidence'
      }, ['proposer'])
    );

    await sleep(1500);

    const run = (await ctx.client.getRun(runId)) as any;
    expect(['running', 'completed', 'failed']).toContain(run.status);
  });

  it('handles multi-message flow (objection -> evaluation -> vote)', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest() as any);
    await sleep(1000);

    await ctx.client.sendMessage(
      runId,
      msg('evaluator', 'Objection', 'macp.modes.decision.v1.ObjectionPayload', {
        proposalId: 'prop-1',
        reason: 'Needs revision',
        severity: 'high'
      }, ['proposer'])
    );
    await sleep(300);

    await ctx.client.sendMessage(
      runId,
      msg('evaluator', 'Evaluation', 'macp.modes.decision.v1.EvaluationPayload', {
        proposalId: 'prop-1',
        recommendation: 'APPROVE',
        confidence: 0.9,
        reason: 'Revised version OK'
      }, ['proposer'])
    );
    await sleep(300);

    await ctx.client.sendMessage(
      runId,
      msg('voter', 'Vote', 'macp.modes.decision.v1.VotePayload', {
        proposalId: 'prop-1',
        vote: 'approve',
        reason: 'Agreed'
      }, ['proposer'])
    );

    // Poll until message events appear
    let messageEvents: any[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(500);
      const result = await ctx.client.listEvents(runId);
      const events = Array.isArray(result) ? result : (result as any).data ?? [];
      messageEvents = events.filter((e: any) => e.type === 'message.sent');
      if (messageEvents.length >= 3) break;
    }
    expect(messageEvents.length).toBeGreaterThanOrEqual(3);
  });
  // ── Signal Tests ────────────────────────────────────────────
  //
  // In MACP, signals flow through TWO planes:
  //
  //   COORDINATION PLANE (binding):
  //     POST /runs/:id/signal → runtime.send() → ack
  //     Control plane records this as "message.sent" (outbound signal)
  //
  //   AMBIENT PLANE (non-binding):
  //     Runtime echoes signals back via stream → EventNormalizer
  //     creates "signal.emitted" canonical events → projection.signals
  //
  // The mock runtime's onSend callback echoes Signal messages back
  // as stream-envelope events, simulating the real runtime behavior.

  it('sends signals during a running session — outbound is recorded', async () => {
    // Create a fresh run — the mock's send() records all calls in sentMessages
    const { runId } = await ctx.client.createRun(decisionModeRequest() as any);
    await sleep(1000);

    // Evaluator sends "progress" signal — starting analysis
    const signal1 = await ctx.client.sendSignal(runId, {
      from: 'evaluator',
      to: ['proposer'],
      messageType: 'Signal',
      signalType: 'progress',
      payload: {
        signalType: 'progress',
        data: 'Starting fraud risk analysis',
        confidence: 0.0
      }
    });
    expect(signal1).toBeDefined();
    await sleep(300);

    // Evaluator sends "completed" signal
    const signal2 = await ctx.client.sendSignal(runId, {
      from: 'evaluator',
      to: ['proposer'],
      messageType: 'Signal',
      signalType: 'completed',
      payload: {
        signalType: 'completed',
        data: 'Fraud evaluation submitted',
        confidence: 1.0
      }
    });
    expect(signal2).toBeDefined();
    await sleep(300);

    // Voter sends "attention" signal
    const signal3 = await ctx.client.sendSignal(runId, {
      from: 'voter',
      to: ['proposer'],
      messageType: 'Signal',
      signalType: 'attention',
      payload: {
        signalType: 'attention',
        data: 'Urgent review required',
        confidence: 0.85
      }
    });
    expect(signal3).toBeDefined();

    // In mock mode, verify the mock runtime received all 3 signal sends
    if (ctx.mockRuntime) {
      const signalSends = ctx.mockRuntime.sentMessages.filter(
        (m) => m.req.messageType === 'Signal'
      );
      expect(signalSends.length).toBeGreaterThanOrEqual(3);

      // Verify signals were sent with empty sessionId (ambient plane)
      for (const s of signalSends) {
        expect(s.req.runtimeSessionId).toBe('');
        expect(s.req.modeName).toBe('');
      }
    }

    // Poll for outbound events — signals are recorded as message.sent
    let signalSentEvents: any[] = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(500);
      const result = await ctx.client.listEvents(runId);
      const events = Array.isArray(result) ? result : (result as any).data ?? [];
      signalSentEvents = events.filter(
        (e: any) =>
          e.type === 'message.sent' &&
          (e.subjectKind === 'signal' || e.subject_kind === 'signal')
      );
      if (signalSentEvents.length >= 3) break;
    }
    expect(signalSentEvents.length).toBeGreaterThanOrEqual(3);
  });

  it('signal payloads are correctly forwarded to runtime', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest() as any);
    await sleep(1000);

    await ctx.client.sendSignal(runId, {
      from: 'evaluator',
      to: ['proposer'],
      messageType: 'Signal',
      signalType: 'progress',
      payload: {
        signalType: 'progress',
        data: 'Analyzing fraud patterns',
        confidence: 0.5
      }
    });

    // In mock mode, inspect the raw request sent to runtime
    if (ctx.mockRuntime) {
      const signalSends = ctx.mockRuntime.sentMessages.filter(
        (m) => m.req.messageType === 'Signal'
      );
      expect(signalSends.length).toBeGreaterThanOrEqual(1);

      const signalReq = signalSends[signalSends.length - 1].req;
      expect(signalReq.runtimeSessionId).toBe('');
      expect(signalReq.modeName).toBe('');
      expect(signalReq.from).toBe('evaluator');

      const payload = JSON.parse(signalReq.payload.toString('utf8'));
      expect(payload.signalType).toBe('progress');
      expect(payload.confidence).toBe(0.5);
    }

    // In all modes: the signal endpoint completed without throwing
  });

  it('coordination messages and signals coexist on the same run', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest() as any);
    await sleep(1000);

    // Coordination plane: send Evaluation (session-bound)
    await ctx.client.sendMessage(
      runId,
      msg('evaluator', 'Evaluation', 'macp.modes.decision.v1.EvaluationPayload', {
        proposalId: 'prop-1',
        recommendation: 'APPROVE',
        confidence: 0.9,
        reason: 'Looks good'
      }, ['proposer'])
    );
    await sleep(200);

    // Ambient plane: send Signal (not session-bound)
    await ctx.client.sendSignal(runId, {
      from: 'evaluator',
      to: ['proposer'],
      messageType: 'Signal',
      signalType: 'done',
      payload: { signalType: 'done', data: 'Evaluation complete' }
    });
    await sleep(500);

    if (ctx.mockRuntime) {
      // In mock mode: verify both message types reached the runtime
      const coordMsgs = ctx.mockRuntime.sentMessages.filter(
        (m) => m.req.messageType === 'Evaluation'
      );
      const signalMsgs = ctx.mockRuntime.sentMessages.filter(
        (m) => m.req.messageType === 'Signal'
      );

      expect(coordMsgs.length).toBeGreaterThanOrEqual(1);
      expect(signalMsgs.length).toBeGreaterThanOrEqual(1);

      // Coordination message has real sessionId
      expect(coordMsgs[0].req.runtimeSessionId).not.toBe('');

      // Signal has empty sessionId
      expect(signalMsgs[0].req.runtimeSessionId).toBe('');
    }

    // In all modes: both API calls should have succeeded (no HTTP errors)
    const run = (await ctx.client.getRun(runId)) as any;
    expect(run.status).toBeDefined();
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
