import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestApp, TestAppContext } from '../helpers/test-app';
import { decisionHappyScript } from '../fixtures/decision-mode';
import { testRuntimeKind } from '../helpers/runtime-kind';
import { waitFor } from '../helpers/wait-for';
import { trustedKeysFromJwks, verifyReceipt } from '../helpers/receipt-verifier';
import { AppException } from '../../src/errors/app-exception';
import { ErrorCode } from '../../src/errors/error-codes';

// Mock-only: the scripted runtime returns the spec's example receipt and key set (RFC-MACP-0013
// A.5). The live proof against a receipt-issuing runtime is decision-receipt-live.integration.spec.ts.
const isRealRuntime = process.env.INTEGRATION_RUNTIME === 'docker' || process.env.INTEGRATION_RUNTIME === 'remote';
const describeMock = isRealRuntime ? describe.skip : describe;

const AUTH = { Authorization: 'Bearer test-key-integration' };
const FIXTURES = join(__dirname, '../fixtures/receipts');
// Raw file text, so "verbatim" is checked byte for byte (the files are pretty-printed, not canonical).
const RECEIPT_TEXT = readFileSync(join(FIXTURES, 'decision_receipt.json'), 'utf8');
const JWKS_TEXT = readFileSync(join(FIXTURES, 'receipt_keys.json'), 'utf8');
const SUPPORTED = { decisionReceipt: { getDecisionReceipt: true, signed: true } };

describeMock('decision receipt routes (integration, mock runtime)', () => {
  let ctx: TestAppContext;
  let runId: string;

  const get = (path: string) => ctx.client.requestNoAuth('GET', path, { headers: AUTH });

  beforeAll(async () => {
    ctx = await createTestApp({
      ...decisionHappyScript(),
      capabilities: SUPPORTED,
      decisionReceipt: RECEIPT_TEXT,
      receiptKeys: JWKS_TEXT
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
    // The routes resolve the run's runtimeSessionId, bound asynchronously after POST /runs.
    await waitFor(
      async () => ((await ctx.client.getRun(runId)) as { runtimeSessionId?: string }).runtimeSessionId ?? null,
      { timeoutMs: 10000, label: 'run bound to its session' }
    );
  });

  afterAll(async () => {
    if (ctx) await ctx.app.close();
  });

  it('GET /runtime/capabilities exposes the decisionReceipt gate', async () => {
    const res = await get('/runtime/capabilities');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ capabilities: SUPPORTED });
  });

  // Runs before anything warms the key-set cache, so the keys route reaches the gate too.
  it('501 DECISION_RECEIPT_UNSUPPORTED on both routes, without calling either RPC, when the runtime does not advertise it', async () => {
    ctx.mockRuntime.setScript({
      ...decisionHappyScript(),
      capabilities: { policyRegistry: { whatIfReplay: true } },
      decisionReceipt: RECEIPT_TEXT,
      receiptKeys: JWKS_TEXT
    });
    const receipt = await get(`/runs/${runId}/receipt`);
    expect(receipt.status).toBe(501);
    expect(receipt.body).toMatchObject({ errorCode: 'DECISION_RECEIPT_UNSUPPORTED' });
    const keys = await get('/runtime/receipt-keys');
    expect(keys.status).toBe(501);
    expect(keys.body).toMatchObject({ errorCode: 'DECISION_RECEIPT_UNSUPPORTED' });
    expect(ctx.mockRuntime.decisionReceiptRequests).toHaveLength(0);
    expect(ctx.mockRuntime.receiptKeysCalls).toBe(0);

    ctx.mockRuntime.setScript({
      ...decisionHappyScript(),
      capabilities: SUPPORTED,
      decisionReceipt: RECEIPT_TEXT,
      receiptKeys: JWKS_TEXT
    });
  });

  it("GET /runs/:id/receipt returns the runtime's receipt verbatim and parsed, for the run's session", async () => {
    const res = await get(`/runs/${runId}/receipt`);
    expect(res.status).toBe(200);
    const body = res.body as { runId: string; sessionId: string; receiptJson: string; receipt: unknown };
    expect(body.runId).toBe(runId);
    expect(typeof body.sessionId).toBe('string');
    expect(body.receiptJson).toBe(RECEIPT_TEXT);
    expect(body.receipt).toEqual(JSON.parse(RECEIPT_TEXT));
    expect(ctx.mockRuntime.decisionReceiptRequests.at(-1)).toEqual({ runtimeSessionId: body.sessionId });
  });

  it('GET /runtime/receipt-keys serves the JWKS verbatim as application/jwk-set+json, cacheable', async () => {
    const res = await get('/runtime/receipt-keys');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/jwk-set\+json/);
    expect(res.headers['cache-control']).toMatch(/^private, max-age=\d+$/);
    expect(Number(/max-age=(\d+)/.exec(res.headers['cache-control'] as string)![1])).toBeLessThanOrEqual(60);
    expect(res.text).toBe(JWKS_TEXT);
  });

  it('the receipt route output verifies attested with the keys route output', async () => {
    const receipt = (await get(`/runs/${runId}/receipt`)).body as { receiptJson: string };
    const keys = await get('/runtime/receipt-keys');
    const result = verifyReceipt(JSON.parse(receipt.receiptJson), trustedKeysFromJwks(JSON.parse(keys.text)));
    expect(result).toEqual({ integrity: 'match', attestations: ['valid'], verdict: 'attested' });
  });

  it('caches the key set (one GetReceiptKeys for repeated reads)', async () => {
    const before = ctx.mockRuntime.receiptKeysCalls;
    await get('/runtime/receipt-keys');
    await get('/runtime/receipt-keys');
    expect(ctx.mockRuntime.receiptKeysCalls).toBe(before);
  });

  it('404 RUN_NOT_FOUND for an unknown run, 400 for a non-UUID id', async () => {
    const res = await get('/runs/00000000-0000-4000-8000-000000000000/receipt');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errorCode: 'RUN_NOT_FOUND' });
    expect((await get('/runs/not-a-uuid/receipt')).status).toBe(400);
  });

  it('409 RECEIPT_UNAVAILABLE when the runtime has no receipt to issue', async () => {
    ctx.mockRuntime.setScript({
      ...decisionHappyScript(),
      capabilities: SUPPORTED,
      decisionReceipt: new AppException(ErrorCode.RECEIPT_UNAVAILABLE, 'session is not RESOLVED', 409)
    });
    const res = await get(`/runs/${runId}/receipt`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ errorCode: 'RECEIPT_UNAVAILABLE' });
  });

  it('404 when the runtime does not know the session (SESSION_NOT_FOUND)', async () => {
    ctx.mockRuntime.setScript({
      ...decisionHappyScript(),
      capabilities: SUPPORTED,
      decisionReceipt: new AppException(ErrorCode.NOT_FOUND, 'GetDecisionReceipt failed: unknown session', 404, {
        macpErrorCode: 'SESSION_NOT_FOUND'
      })
    });
    const res = await get(`/runs/${runId}/receipt`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ errorCode: 'NOT_FOUND', metadata: { macpErrorCode: 'SESSION_NOT_FOUND' } });
  });
});
