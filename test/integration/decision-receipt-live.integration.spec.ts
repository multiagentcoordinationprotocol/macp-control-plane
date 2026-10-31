import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as protobuf from 'protobufjs';
import { authedRuntimeSkipReason, describeWithAuthedRuntime } from '../helpers/real-runtime-gate';
import { trustedKeysFromJwks, verifyReceipt } from 'macp-sdk-typescript';
import { createTestApp, TestAppContext } from '../helpers/test-app';
import { waitFor } from '../helpers/wait-for';

/**
 * `GET /runs/:id/receipt` and `GET /runtime/receipt-keys` against a REAL receipt-issuing
 * macp-runtime (>= 0.11.0, RFC-MACP-0013 §13), end to end through HTTP: the receipt the CP proxies
 * must verify with the key set the CP proxies.
 *
 * Gated twice. `describeWithAuthedRuntime` needs `INTEGRATION_RUNTIME=remote`, a runtime at
 * `RUNTIME_ADDRESS` started with `MACP_AUTH_TOKENS_FILE`, and `MACP_RUNTIME_AUTH_TOKENS_FILE`
 * pointing at the same file (tokens as in what-if-replay-live.integration.spec.ts).
 *
 * `EXPECT_DECISION_RECEIPTS=signed|unsigned` (CI's `live-runtime` job runs one leg of each against
 * `macp-runtime:0.11.0`) makes the spec strict: the runtime MUST advertise
 * `decisionReceipt.getDecisionReceipt` with that `signed` value, and every test runs. Unset, a
 * runtime that does not advertise the capability makes every test return early with a warning
 * (Jest cannot skip after an async probe), so the spec stays usable against older runtimes.
 *
 * Start the runtime with a signing key to expect an attested receipt: `MACP_RECEIPT_SIGNING_KEY_PATH`
 * or `MACP_RECEIPT_SIGNING_KEY` (not both; that aborts startup), `MACP_RECEIPT_SIGNING_KID` and
 * `MACP_RUNTIME_ID` (`MACP_RECEIPT_PUBLIC_KEYS_PATH` optionally publishes retired keys). Without a
 * key it advertises `signed: false` and the receipt is integrity-only, still served.
 */
const RUNTIME_ADDRESS = process.env.RUNTIME_ADDRESS ?? '127.0.0.1:50051';
const BUYER = { token: 'agent-alpha-token', sender: 'agent-alpha' };
const SELLER = { token: 'agent-beta-token', sender: 'agent-beta' };
const CP_OBSERVER_TOKEN = 'cp-observer-token';
const PROPOSAL = 'macp.mode.proposal.v1';
const AUTH = { Authorization: 'Bearer test-key-integration' };
const EXPECTED = process.env.EXPECT_DECISION_RECEIPTS;
if (EXPECTED !== undefined && EXPECTED !== 'signed' && EXPECTED !== 'unsigned') {
  throw new Error(`EXPECT_DECISION_RECEIPTS must be "signed" or "unsigned", got ${JSON.stringify(EXPECTED)}`);
}
// A strict leg that would silently describe.skip (missing tokens file, wrong INTEGRATION_RUNTIME)
// is a misconfigured CI job, not a pass.
if (EXPECTED && authedRuntimeSkipReason()) {
  throw new Error(`EXPECT_DECISION_RECEIPTS is set but the live gate is closed: ${authedRuntimeSkipReason()}`);
}

function loadProtoDir(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { protoDir } = require('@multiagentcoordinationprotocol/proto');
  return protoDir as string;
}

describeWithAuthedRuntime('Decision receipts against a live macp-runtime (integration)', () => {
  let ctx: TestAppContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ServiceCtor: any;
  let root: protobuf.Root;
  let advertised: { getDecisionReceipt?: boolean; signed?: boolean } | undefined;
  const savedEnv: Record<string, string | undefined> = {};

  function overrideEnv(name: string, value: string): void {
    savedEnv[name] = process.env[name];
    process.env[name] = value;
  }

  function encode(type: string, fields: Record<string, unknown>): Buffer {
    const t = root.lookupType(type);
    return Buffer.from(t.encode(t.create(fields)).finish());
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function send(agent: typeof BUYER, sessionId: string, messageType: string, payload: Buffer): Promise<any> {
    return new Promise((resolve, reject) => {
      const client = new ServiceCtor(RUNTIME_ADDRESS, grpc.credentials.createInsecure());
      const md = new grpc.Metadata();
      md.set('authorization', `Bearer ${agent.token}`);
      const envelope = {
        macpVersion: '1.0',
        mode: PROPOSAL,
        messageType,
        messageId: randomUUID(),
        sessionId,
        sender: agent.sender,
        timestampUnixMs: Date.now(),
        payload
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client.Send({ envelope }, md, (err: any, res: any) => {
        client.close();
        if (err) return reject(err);
        if (res?.ack?.ok !== true)
          return reject(new Error(`${messageType} refused: ${JSON.stringify(res?.ack?.error)}`));
        resolve(res);
      });
    });
  }

  /** Opened by the buyer and resolved by the buyer's Commitment (the what-if live spec's session). */
  async function resolvedProposalSession(sessionId: string, opts: { resolve?: boolean } = {}): Promise<void> {
    const versions = { modeVersion: '1.0.0', configurationVersion: 'config.default', policyVersion: 'policy.default' };
    await send(
      BUYER,
      sessionId,
      'SessionStart',
      encode('macp.v1.SessionStartPayload', {
        intent: 'receipt live',
        participants: [BUYER.sender, SELLER.sender],
        ttlMs: 300000,
        ...versions
      })
    );
    if (opts.resolve === false) return;
    await send(
      SELLER,
      sessionId,
      'Proposal',
      encode('macp.modes.proposal.v1.ProposalPayload', { proposalId: 'p1', title: 'offer', summary: 'terms' })
    );
    await send(
      SELLER,
      sessionId,
      'Accept',
      encode('macp.modes.proposal.v1.AcceptPayload', { proposalId: 'p1', reason: 'ok' })
    );
    await send(
      BUYER,
      sessionId,
      'Accept',
      encode('macp.modes.proposal.v1.AcceptPayload', { proposalId: 'p1', reason: 'ok' })
    );
    await send(
      BUYER,
      sessionId,
      'Commitment',
      encode('macp.v1.CommitmentPayload', {
        commitmentId: 'c1',
        action: 'proposal.accepted',
        authorityScope: 'commercial',
        reason: 'bound',
        outcomePositive: true,
        ...versions
      })
    );
  }

  beforeAll(async () => {
    // Discovery stays on: its WatchSessions `resolved` event is what completes the run, as in
    // production (a Commitment envelope alone does not).
    overrideEnv('SESSION_DISCOVERY_ENABLED', 'true');
    overrideEnv('RUNTIME_BEARER_TOKEN', CP_OBSERVER_TOKEN);
    ctx = await createTestApp();
    const protoDir = loadProtoDir();
    const pkg = protoLoader.loadSync(['macp/v1/core.proto', 'macp/v1/envelope.proto'], {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs: [protoDir]
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ServiceCtor = (grpc.loadPackageDefinition(pkg) as any).macp.v1.MACPRuntimeService;
    root = new protobuf.Root();
    root.resolvePath = (_origin: string, target: string) => (target.startsWith('/') ? target : `${protoDir}/${target}`);
    await root.load(['macp/v1/core.proto', 'macp/modes/proposal/v1/proposal.proto']);

    const caps = await ctx.client.requestNoAuth('GET', '/runtime/capabilities', { headers: AUTH });
    advertised = (caps.body as { capabilities?: { decisionReceipt?: typeof advertised } }).capabilities
      ?.decisionReceipt;
    if (EXPECTED) {
      // Strict leg: a runtime that stopped advertising (or a mis-booted signing key) is a failure.
      expect(advertised).toEqual({ getDecisionReceipt: true, signed: EXPECTED === 'signed' });
    } else if (advertised?.getDecisionReceipt !== true) {
      // eslint-disable-next-line no-console
      console.warn('[decision-receipt-live] runtime does not advertise decisionReceipt.getDecisionReceipt; skipping');
    }
  }, 90000);

  const unsupported = () => advertised?.getDecisionReceipt !== true;

  async function createRun(sessionId: string): Promise<string> {
    const { runId } = await ctx.client.createRun({
      mode: 'sandbox',
      runtime: { kind: 'rust' },
      session: {
        sessionId,
        modeName: PROPOSAL,
        modeVersion: '1.0.0',
        configurationVersion: 'config.default',
        policyVersion: 'policy.default',
        ttlMs: 300000,
        participants: [{ id: BUYER.sender }, { id: SELLER.sender }]
      }
    });
    return runId;
  }

  afterAll(async () => {
    if (ctx) await ctx.app.close();
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }, 90000);

  it('serves a receipt for a resolved run that verifies with the served key set', async () => {
    if (unsupported()) return;
    const sessionId = randomUUID();
    const runId = await createRun(sessionId);
    await resolvedProposalSession(sessionId);
    await waitFor(
      async () => {
        const run = (await ctx.client.getRun(runId)) as { status?: string };
        return run.status === 'completed' ? run : null;
      },
      { timeoutMs: 20000, label: 'run completed after the Commitment' }
    );

    const res = await ctx.client.requestNoAuth('GET', `/runs/${runId}/receipt`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = res.body as { runId: string; sessionId: string; receiptJson: string; receipt: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(body).toMatchObject({ runId, sessionId });
    expect(body.receipt).toEqual(JSON.parse(body.receiptJson));
    // §13 items 2 and 4: format, verbatim wire, no transcript.
    expect(body.receipt).toMatchObject({
      receipt_format: 'macp-receipt/1',
      session_id: sessionId,
      mode: PROPOSAL,
      commitment: { commitment_id: 'c1', action: 'proposal.accepted', outcome_positive: true }
    });
    expect(typeof body.receipt.commitment_wire_b64).toBe('string');
    expect(body.receipt).not.toHaveProperty('transcript');

    const keys = await ctx.client.requestNoAuth('GET', '/runtime/receipt-keys', { headers: AUTH });
    expect(keys.status).toBe(200);
    expect(keys.headers['content-type']).toMatch(/^application\/jwk-set\+json/);
    const jwks = JSON.parse(keys.text) as { keys: Array<Record<string, unknown>> };
    for (const k of jwks.keys)
      for (const m of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']) expect(k).not.toHaveProperty(m);

    // §13: the issuer is `runtime:<MACP_RUNTIME_ID>` whether or not the runtime signs.
    const runtimeId = process.env.MACP_RUNTIME_ID;
    if (EXPECTED && !runtimeId) throw new Error('strict leg needs MACP_RUNTIME_ID (start-live-runtime.sh prints it)');
    if (runtimeId) expect(body.receipt.issuer).toBe(`runtime:${runtimeId}`);

    const verdict = verifyReceipt(JSON.parse(body.receiptJson), trustedKeysFromJwks(jwks));
    const expectSigned = EXPECTED ? EXPECTED === 'signed' : advertised?.signed === true;
    if (expectSigned) {
      expect(verdict).toEqual({ integrity: 'match', attestations: ['valid'], verdict: 'attested' });
      // §13 item 5: the protected header is exactly {"alg":"EdDSA","kid":<kid>}.
      const header = JSON.parse(
        Buffer.from((body.receipt.attestations[0].jws as string).split('.')[0], 'base64url').toString('utf8')
      );
      expect(Object.keys(header).sort()).toEqual(['alg', 'kid']);
      expect(header.alg).toBe('EdDSA');
      // Signed with the key the runtime was booted with.
      const kid = process.env.MACP_RECEIPT_SIGNING_KID;
      if (EXPECTED && !kid)
        throw new Error('signed leg needs MACP_RECEIPT_SIGNING_KID (start-live-runtime.sh prints it)');
      if (kid) expect(header.kid).toBe(kid);
    } else {
      expect(verdict).toEqual({ integrity: 'match', attestations: [], verdict: 'integrity_only' });
      expect(body.receipt.attestations).toEqual([]);
      // CI's unsigned leg publishes no retired keys either (§13 item 8 would allow them).
      if (EXPECTED === 'unsigned') expect(jwks.keys).toEqual([]);
    }

    // §13 item 6: served byte-identical on a later call.
    const again = await ctx.client.requestNoAuth('GET', `/runs/${runId}/receipt`, { headers: AUTH });
    expect((again.body as { receiptJson: string }).receiptJson).toBe(body.receiptJson);
  }, 60000);

  it('answers 409 RECEIPT_UNAVAILABLE for a run whose session is still OPEN', async () => {
    if (unsupported()) return;
    const sessionId = randomUUID();
    const runId = await createRun(sessionId);
    await resolvedProposalSession(sessionId, { resolve: false });
    await waitFor(
      async () => ((await ctx.client.getRun(runId)) as { runtimeSessionId?: string }).runtimeSessionId ?? null,
      { timeoutMs: 20000, label: 'run bound to its session' }
    );
    const res = await ctx.client.requestNoAuth('GET', `/runs/${runId}/receipt`, { headers: AUTH });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ errorCode: 'RECEIPT_UNAVAILABLE' });
  }, 60000);
});
