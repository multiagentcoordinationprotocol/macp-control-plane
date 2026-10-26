import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as protobuf from 'protobufjs';
import { describeWithAuthedRuntime } from '../helpers/real-runtime-gate';
import { createTestApp, TestAppContext } from '../helpers/test-app';
import { waitFor } from '../helpers/wait-for';

/**
 * `POST /runs/:id/what-if` and `GET /runtime/capabilities` against a REAL macp-runtime ≥ 0.10.0
 * (W4.1). The mock spec (`what-if-replay.integration.spec.ts`) checks the CP against its own model
 * of `WhatIfReplay`; this one asks the runtime, end to end through HTTP.
 *
 * The session mirrors the runtime's own `test_what_if_replay.rs`: a proposal-mode session
 * SessionStart(0) → Proposal(1) → Accept(2) → Accept(3) → Commitment(4) by the buyer, replayed
 * under a candidate where only the seller may commit, so the replays diverge at index 4.
 *
 * Whether the runtime still holds that resolved session's history is the operator's choice, and
 * this spec follows it: set `MACP_COMPACT_TERMINAL_LOGS=0` here exactly as the runtime was started
 * to expect the diff; leave it unset (the runtime default compacts) to expect
 * `409 HISTORY_UNAVAILABLE`.
 *
 * Gated with `describeWithAuthedRuntime`: `INTEGRATION_RUNTIME=remote`, a runtime at
 * `RUNTIME_ADDRESS` started with `MACP_AUTH_TOKENS_FILE`, and `MACP_RUNTIME_AUTH_TOKENS_FILE`
 * pointing at the same file, holding:
 *   {"token":"cp-observer-token","sender":"macp-control-plane","is_observer":true}
 *   {"token":"agent-alpha-token","sender":"agent-alpha"}
 *   {"token":"agent-beta-token","sender":"agent-beta"}
 * The CP never sends (observer invariant); the raw agent client plays macp-sdk's role.
 * Verified against the released image `macp-runtime:0.10.0`, both retention settings.
 */
const RUNTIME_ADDRESS = process.env.RUNTIME_ADDRESS ?? '127.0.0.1:50051';
const BUYER = { token: 'agent-alpha-token', sender: 'agent-alpha' };
const SELLER = { token: 'agent-beta-token', sender: 'agent-beta' };
const CP_OBSERVER_TOKEN = 'cp-observer-token';
const PROPOSAL = 'macp.mode.proposal.v1';
const KEEPS_TERMINAL_LOGS = process.env.MACP_COMPACT_TERMINAL_LOGS === '0';
const AUTH = { Authorization: 'Bearer test-key-integration' };

function loadProtoDir(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { protoDir } = require('@multiagentcoordinationprotocol/proto');
  return protoDir as string;
}

describeWithAuthedRuntime('What-if replay against a live macp-runtime (integration)', () => {
  let ctx: TestAppContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ServiceCtor: any;
  let root: protobuf.Root;
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

  /** The runtime's own what-if fixture, opened by the buyer and resolved by the buyer's Commitment. */
  async function resolvedProposalSession(sessionId: string): Promise<void> {
    const versions = { modeVersion: '1.0.0', configurationVersion: 'config.default', policyVersion: 'policy.default' };
    await send(
      BUYER,
      sessionId,
      'SessionStart',
      encode('macp.v1.SessionStartPayload', {
        intent: 'what-if live',
        participants: [BUYER.sender, SELLER.sender],
        ttlMs: 300000,
        ...versions
      })
    );
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
  }, 90000);

  afterAll(async () => {
    if (ctx) await ctx.app.close();
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }, 90000);

  it('advertises policyRegistry.whatIfReplay on GET /runtime/capabilities', async () => {
    const res = await ctx.client.requestNoAuth('GET', '/runtime/capabilities', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ capabilities: { policyRegistry: { whatIfReplay: true } } });
  });

  it(
    KEEPS_TERMINAL_LOGS
      ? 'replays a resolved run under a candidate and reports the divergence at the Commitment'
      : 'answers 409 HISTORY_UNAVAILABLE for a resolved run whose log the runtime compacted',
    async () => {
      const sessionId = randomUUID();
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
      await resolvedProposalSession(sessionId);
      await waitFor(
        async () => {
          const run = (await ctx.client.getRun(runId)) as { status?: string };
          return run.status === 'completed' ? run : null;
        },
        { timeoutMs: 20000, label: 'run completed after the Commitment' }
      );

      const res = await ctx.client.requestNoAuth('POST', `/runs/${runId}/what-if`, {
        headers: AUTH,
        body: {
          candidate: {
            policyId: 'what-if.seller-commits',
            schemaVersion: 1,
            rules: { commitment: { authority: 'designated_role', designated_roles: [SELLER.sender] } }
          }
        }
      });

      if (!KEEPS_TERMINAL_LOGS) {
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ errorCode: 'HISTORY_UNAVAILABLE' });
        return;
      }

      expect(res.status).toBe(200);
      const body = res.body as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(body).toMatchObject({
        runId,
        sessionId,
        recordedPolicyId: 'policy.default',
        candidatePolicyId: 'what-if.seller-commits',
        firstDivergence: 4,
        recorded: {
          state: 'RESOLVED',
          resolution: { commitmentId: 'c1', action: 'proposal.accepted', outcomePositive: true },
          resolvedBy: { historyIndex: 4, messageType: 'Commitment' }
        },
        candidate: { state: 'OPEN', resolution: null, resolvedBy: null }
      });
      expect(body.entries.map((e: { historyIndex: number }) => e.historyIndex)).toEqual([0, 1, 2, 3, 4]);
      expect(body.entries[4]).toMatchObject({
        messageType: 'Commitment',
        recorded: { kind: 'APPLIED', state: 'RESOLVED', errorCode: null },
        candidate: { kind: 'REFUSED', errorCode: expect.any(String) }
      });

      // Read-only: the runtime still reports the recorded outcome.
      const run = (await ctx.client.getRun(runId)) as { status?: string };
      expect(run.status).toBe('completed');
    },
    60000
  );
});
