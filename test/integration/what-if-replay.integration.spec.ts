import { createTestApp, TestAppContext } from '../helpers/test-app';
import { decisionHappyScript } from '../fixtures/decision-mode';
import { testRuntimeKind } from '../helpers/runtime-kind';
import { AppException } from '../../src/errors/app-exception';
import { ErrorCode } from '../../src/errors/error-codes';
import { RuntimeWhatIfReplayResult } from '../../src/contracts/runtime';

// Mock-only: the pinned runtime image (0.9.0) predates WhatIfReplay (runtime 0.10).
const isRealRuntime = process.env.INTEGRATION_RUNTIME === 'docker' || process.env.INTEGRATION_RUNTIME === 'remote';
const describeMock = isRealRuntime ? describe.skip : describe;

const AUTH = { Authorization: 'Bearer test-key-integration' };

const diverging: RuntimeWhatIfReplayResult = {
  candidatePolicyId: 'cand',
  recordedPolicyId: 'policy.default',
  recorded: {
    state: 'SESSION_STATE_RESOLVED',
    resolution: Buffer.alloc(0),
    resolvedByHistoryIndex: 2,
    resolvedByMessageId: 'm3',
    resolvedByMessageType: 'Commitment'
  },
  candidate: {
    state: 'SESSION_STATE_OPEN',
    resolution: Buffer.alloc(0),
    resolvedByHistoryIndex: 0,
    resolvedByMessageId: '',
    resolvedByMessageType: ''
  },
  firstDivergence: 2,
  denials: [],
  entries: [
    {
      historyIndex: 2,
      messageId: 'm3',
      messageType: 'Commitment',
      recorded: { kind: 'KIND_APPLIED', state: 'SESSION_STATE_RESOLVED', errorCode: '', details: Buffer.alloc(0) },
      candidate: {
        kind: 'KIND_REFUSED',
        state: 'SESSION_STATE_OPEN',
        errorCode: 'POLICY_DENIED',
        details: Buffer.alloc(0)
      }
    }
  ]
};

describeMock('POST /runs/:id/what-if (integration, mock runtime)', () => {
  let ctx: TestAppContext;
  let runId: string;

  const whatIf = (id: string, body: unknown) =>
    ctx.client.requestNoAuth('POST', `/runs/${id}/what-if`, { headers: AUTH, body: body as object });

  beforeAll(async () => {
    ctx = await createTestApp({
      ...decisionHappyScript(),
      capabilities: { policyRegistry: { registerPolicy: true, whatIfReplay: true, ruleExtensions: [] } },
      whatIfReplay: diverging
    });
    const run = await ctx.client.createRun({
      mode: 'sandbox',
      runtime: { kind: testRuntimeKind() },
      session: {
        modeName: 'macp.mode.decision.v1',
        modeVersion: '1.0.0',
        configurationVersion: '1.0.0',
        ttlMs: 60000,
        participants: [{ id: 'agent-a' }]
      }
    });
    runId = run.runId;
  });

  afterAll(async () => {
    if (ctx) await ctx.app.close();
  });

  it('GET /runtime/capabilities exposes the whatIfReplay gate', async () => {
    const res = await ctx.client.requestNoAuth('GET', '/runtime/capabilities', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ capabilities: { policyRegistry: { whatIfReplay: true } } });
  });

  it('returns the diff with the session mode defaulted in', async () => {
    const res = await whatIf(runId, { candidate: { rules: { voting: { algorithm: 'unanimous' } } } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      runId,
      recordedPolicyId: 'policy.default',
      recorded: { state: 'RESOLVED', resolvedBy: { historyIndex: 2, messageId: 'm3' } },
      candidate: { state: 'OPEN', resolution: null, resolvedBy: null },
      firstDivergence: 2,
      entries: [{ recorded: { kind: 'APPLIED' }, candidate: { kind: 'REFUSED', errorCode: 'POLICY_DENIED' } }]
    });
    const sent = ctx.mockRuntime.whatIfRequests.at(-1)!;
    expect(sent.candidate).toMatchObject({ mode: 'macp.mode.decision.v1', schemaVersion: 3 });
  });

  it('400s a body that is not a candidate, and rules outside the closed set', async () => {
    expect((await whatIf(runId, { rules: {} })).status).toBe(400);
    expect((await whatIf(runId, { candidate: { rules: [] } })).status).toBe(400);
    expect((await whatIf(runId, { candidate: { rules: {}, schemaVersion: 9 } })).status).toBe(400);
    const typo = await whatIf(runId, { candidate: { rules: { voting: { algorithmm: 'unanimous' } } } });
    expect(typo.status).toBe(400);
    expect(typo.body).toMatchObject({ errorCode: ErrorCode.INVALID_POLICY_DEFINITION });
  });

  it('ignores unknown candidate keys (the global ValidationPipe whitelists before the route pipe)', async () => {
    expect((await whatIf(runId, { candidate: { rules: {}, extra: 1 } })).status).toBe(200);
    expect(ctx.mockRuntime.whatIfRequests.at(-1)!.candidate).not.toHaveProperty('extra');
  });

  it('404s an unknown run', async () => {
    const res = await whatIf('00000000-0000-4000-8000-000000000000', { candidate: { rules: {} } });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errorCode: 'RUN_NOT_FOUND' });
  });

  it('surfaces HISTORY_UNAVAILABLE as 409', async () => {
    ctx.mockRuntime.setScript({
      ...decisionHappyScript(),
      capabilities: { policyRegistry: { whatIfReplay: true } },
      whatIfReplay: new AppException(ErrorCode.HISTORY_UNAVAILABLE, 'history was compacted', 409)
    });
    const res = await whatIf(runId, { candidate: { rules: {} } });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ errorCode: 'HISTORY_UNAVAILABLE' });
  });

  it('501s when the runtime does not advertise it', async () => {
    ctx.mockRuntime.setScript({ ...decisionHappyScript(), capabilities: { policyRegistry: { registerPolicy: true } } });
    const res = await whatIf(runId, { candidate: { rules: {} } });
    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({ errorCode: 'WHAT_IF_REPLAY_UNSUPPORTED' });
  });
});
