import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as protobuf from 'protobufjs';
import { describeWithRealRuntime } from '../helpers/real-runtime-gate';
import { createTestApp, TestAppContext } from '../helpers/test-app';
import { decisionModeRequest } from '../fixtures/decision-mode';
import { waitFor } from '../helpers/wait-for';
import { RunDescriptor } from '../../src/contracts/control-plane';

/**
 * `POST /runs/:id/{suspend,resume,cancel}` against a REAL macp-runtime.
 *
 * Runtime 0.14.0 (RFC-MACP-0001 §7.6 item 9) refuses `SessionSuspend` / `SessionResume` /
 * `SessionCancel` submitted through `Send` with FORBIDDEN, so the dedicated `SuspendSession` /
 * `ResumeSession` / `CancelSession` RPCs the control plane calls (src/runs/run-executor.service.ts)
 * are the only way to drive these transitions. Until now they were proven only against the scripted
 * mock (runs-suspend-resume and runs-cancel's Option B case are mock-only), so nothing checked that
 * the runtime accepts them from the control plane's identity, or that a cancel reaches the runtime
 * rather than only marking the run cancelled locally (the Option B path used to swallow a
 * CancelSession failure and mark the run cancelled anyway).
 *
 * The runtime authorizes all three RPCs like a Commitment: the initiator, or the roles a bound
 * policy's `commitment.authority` delegates (macp-runtime src/server.rs `cancel_session` /
 * `suspend_session` / `resume_session` → `check_commitment_authority`). So:
 *  - with a policy whose `designated_roles` names the control plane, the round trip succeeds and the
 *    runtime's own `GetSession` state follows each step;
 *  - under `policy.default` (initiator-only) the runtime answers FORBIDDEN, which the control plane
 *    maps to HTTP 403 and leaves the run `running` — for cancel too, even with
 *    `cancellationDelegated: true`.
 *
 * Identities match signal-auth-live: on the docker-compose runtime (dev auth) the bearer value is
 * the sender and the control plane's is `RUNTIME_DEV_AGENT_ID`; with `INTEGRATION_RUNTIME=remote`
 * and `MACP_RUNTIME_AUTH_TOKENS_FILE` (test/scripts/start-live-runtime.sh) the tokens map to
 * `agent-alpha` and `macp-control-plane`.
 */
const RUNTIME_ADDRESS = process.env.RUNTIME_ADDRESS ?? '127.0.0.1:50051';
const authenticated =
  (process.env.INTEGRATION_RUNTIME ?? '').toLowerCase() === 'remote' && !!process.env.MACP_RUNTIME_AUTH_TOKENS_FILE;
const AGENT = authenticated
  ? { token: 'agent-alpha-token', sender: 'agent-alpha' }
  : { token: 'agent-alpha', sender: 'agent-alpha' };
const CP_SENDER = authenticated ? 'macp-control-plane' : (process.env.RUNTIME_DEV_AGENT_ID ?? 'macp-control-plane');

function loadProtoDir(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { protoDir } = require('@multiagentcoordinationprotocol/proto');
  return protoDir as string;
}

describeWithRealRuntime('Run suspend / resume / cancel against a live macp-runtime (integration)', () => {
  let ctx: TestAppContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ServiceCtor: any;
  let SessionStartPayload: protobuf.Type;
  const savedEnv: Record<string, string | undefined> = {};
  const openSessions: string[] = [];
  const policyId = `cp-live.delegated-control.${randomUUID().slice(0, 8)}`;

  function overrideEnv(name: string, value: string): void {
    savedEnv[name] = process.env[name];
    process.env[name] = value;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function agentCall(method: string, request: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const client = new ServiceCtor(RUNTIME_ADDRESS, grpc.credentials.createInsecure());
      const md = new grpc.Metadata();
      md.set('authorization', `Bearer ${AGENT.token}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client[method](request, md, (err: any, res: any) => {
        client.close();
        if (err) return reject(err);
        resolve(res);
      });
    });
  }

  async function runtimeState(sessionId: string): Promise<string> {
    const res = await agentCall('GetSession', { sessionId });
    return res.metadata.state as string;
  }

  /** Pre-allocate a run, open its session as the initiator agent, and wait for the run to bind. */
  async function openRun(
    policyVersion: string,
    metadata?: Record<string, unknown>
  ): Promise<{ runId: string; sessionId: string }> {
    const sessionId = randomUUID();
    const base = decisionModeRequest();
    const body: RunDescriptor = {
      ...base,
      session: {
        ...base.session,
        sessionId,
        policyVersion,
        ttlMs: 120000,
        participants: [{ id: AGENT.sender }, { id: CP_SENDER }],
        ...(metadata ? { metadata } : {})
      }
    };
    const { runId } = await ctx.client.createRun(body);
    const res = await agentCall('Send', {
      envelope: {
        macpVersion: '1.0',
        mode: body.session.modeName,
        messageType: 'SessionStart',
        messageId: randomUUID(),
        sessionId,
        sender: AGENT.sender,
        timestampUnixMs: Date.now(),
        payload: Buffer.from(
          SessionStartPayload.encode(
            SessionStartPayload.create({
              intent: 'control-plane suspend/resume/cancel verification',
              participants: [AGENT.sender, CP_SENDER],
              modeVersion: body.session.modeVersion,
              configurationVersion: body.session.configurationVersion,
              policyVersion,
              ttlMs: 120000
            })
          ).finish()
        )
      }
    });
    expect(res?.ack?.ok).toBe(true);
    openSessions.push(sessionId);
    await waitFor(
      async () => {
        const run = (await ctx.client.getRun(runId)) as { status?: string };
        return run.status === 'running' ? run : null;
      },
      { timeoutMs: 20000, label: 'run running' }
    );
    return { runId, sessionId };
  }

  beforeAll(async () => {
    if (authenticated) overrideEnv('RUNTIME_BEARER_TOKEN', 'cp-observer-token');
    ctx = await createTestApp();
    const protoDir = loadProtoDir();
    const pkgDef = protoLoader.loadSync(['macp/v1/core.proto', 'macp/v1/envelope.proto'], {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs: [protoDir]
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ServiceCtor = (grpc.loadPackageDefinition(pkgDef) as any).macp.v1.MACPRuntimeService;
    const root = new protobuf.Root();
    root.resolvePath = (_origin: string, target: string) => (target.startsWith('/') ? target : `${protoDir}/${target}`);
    await root.load(['macp/v1/core.proto']);
    SessionStartPayload = root.lookupType('macp.v1.SessionStartPayload');

    const reg = await ctx.client.requestNoAuth('POST', '/runtime/policies', {
      headers: { Authorization: 'Bearer test-key-integration' },
      body: {
        policyId,
        mode: 'macp.mode.decision.v1',
        description: 'control plane may suspend, resume and cancel (runs-control-live)',
        rules: { commitment: { authority: 'designated_role', designated_roles: [CP_SENDER] } }
      }
    });
    expect(reg.status).toBe(201);
  }, 90000);

  afterAll(async () => {
    for (const sessionId of openSessions) {
      await agentCall('CancelSession', { sessionId, reason: 'runs-control-live cleanup' }).catch(() => undefined);
    }
    if (ctx) {
      await ctx.client
        .requestNoAuth('DELETE', `/runtime/policies/${policyId}`, {
          headers: { Authorization: 'Bearer test-key-integration' }
        })
        .catch(() => undefined);
      await ctx.app.close();
    }
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }, 90000);

  it('suspends, resumes and cancels through the runtime when a policy delegates authority to the control plane', async () => {
    const { runId, sessionId } = await openRun(policyId, { cancellationDelegated: true });

    const suspended = await ctx.client.request('POST', `/runs/${runId}/suspend`, { body: { reason: 'live suspend' } });
    expect(suspended.statusCode).toBeUndefined();
    expect(suspended.status).toBe('suspended');
    expect(await runtimeState(sessionId)).toBe('SESSION_STATE_SUSPENDED');

    const resumed = await ctx.client.request('POST', `/runs/${runId}/resume`, { body: { reason: 'live resume' } });
    expect(resumed.statusCode).toBeUndefined();
    expect(resumed.status).toBe('running');
    expect(await runtimeState(sessionId)).toBe('SESSION_STATE_OPEN');

    const cancelled = (await ctx.client.cancelRun(runId, 'live cancel')) as { status?: string; statusCode?: number };
    expect(cancelled.statusCode).toBeUndefined();
    expect(cancelled.status).toBe('cancelled');
    // The run's status alone proves nothing about the runtime: its own state must be terminal.
    expect(await runtimeState(sessionId)).toBe('SESSION_STATE_CANCELLED');
  }, 60000);

  it('answers 403 FORBIDDEN and leaves the run running when no policy delegates authority (initiator-only default)', async () => {
    // cancellationDelegated routes cancel to CancelSession (Option B) so the runtime gets to refuse it.
    const { runId, sessionId } = await openRun('policy.default', { cancellationDelegated: true });

    const res = await ctx.client.requestNoAuth('POST', `/runs/${runId}/suspend`, {
      headers: { Authorization: 'Bearer test-key-integration' },
      body: { reason: 'not delegated' }
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ errorCode: 'FORBIDDEN' });

    const run = (await ctx.client.getRun(runId)) as { status?: string };
    expect(run.status).toBe('running');
    expect(await runtimeState(sessionId)).toBe('SESSION_STATE_OPEN');

    // The runtime refuses CancelSession the same way; the run must NOT be marked cancelled while
    // the runtime session stays OPEN.
    const cancel = await ctx.client.requestNoAuth('POST', `/runs/${runId}/cancel`, {
      headers: { Authorization: 'Bearer test-key-integration' },
      body: { reason: 'not delegated' }
    });
    expect(cancel.status).toBe(403);
    expect(cancel.body).toMatchObject({ errorCode: 'FORBIDDEN' });

    const afterCancel = (await ctx.client.getRun(runId)) as { status?: string };
    expect(afterCancel.status).toBe('running');
    expect(await runtimeState(sessionId)).toBe('SESSION_STATE_OPEN');
  }, 60000);
});
