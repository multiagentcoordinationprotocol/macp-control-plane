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
 * `senderAuthenticated` on signals against a REAL macp-runtime (plans/macp-runtime-0.9.0-alignment.md,
 * Phase 5 AC3). The runtime sets `WatchSignalsResponse.sender_authenticated` per server, not per
 * signal: `true` when its security layer authenticates senders (a configured auth-tokens file),
 * `false` in dev mode, where the bearer value is taken as the sender (src/server.rs:1407-1413 at
 * macp-runtime-v0.9.0).
 *
 *  - `INTEGRATION_RUNTIME=remote` with `MACP_RUNTIME_AUTH_TOKENS_FILE` set → the runtime is assumed
 *    to run with that file as `MACP_AUTH_TOKENS_FILE`, so the signal carries `true`. The file needs
 *    `{"tokens":[{"token":"cp-observer-token","sender":"macp-control-plane","is_observer":true},
 *    {"token":"agent-alpha-token","sender":"agent-alpha","can_start_sessions":true}]}` (the same
 *    entries `admission-parity-live` uses; extra entries are fine). No compose service runs an
 *    authenticated runtime, so CI's docker tier only exercises the `false` path.
 *  - otherwise (e.g. the docker-compose runtime, dev auth) → `false`; the agent's bearer is its sender.
 *    Dev mode grants no `is_observer`, so the CP's dev bearer (`RUNTIME_DEV_AGENT_ID`) can only read
 *    the session as a participant — it is listed in `SessionStart.participants` on that path.
 *
 * An agent opens a session the CP pre-allocated, then emits one ambient Signal correlated to it; the
 * CP's SignalConsumer (WatchSignals, gated on SESSION_DISCOVERY_ENABLED) persists `signal.emitted`.
 */
const RUNTIME_ADDRESS = process.env.RUNTIME_ADDRESS ?? '127.0.0.1:50051';
const authenticated =
  (process.env.INTEGRATION_RUNTIME ?? '').toLowerCase() === 'remote' && !!process.env.MACP_RUNTIME_AUTH_TOKENS_FILE;
const AGENT = authenticated
  ? { token: 'agent-alpha-token', sender: 'agent-alpha' }
  : { token: 'agent-alpha', sender: 'agent-alpha' };
const SESSION_PARTICIPANTS = authenticated
  ? [AGENT.sender]
  : [AGENT.sender, process.env.RUNTIME_DEV_AGENT_ID ?? 'macp-control-plane'];

function loadProtoDir(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { protoDir } = require('@multiagentcoordinationprotocol/proto');
  return protoDir as string;
}

describeWithRealRuntime('Signal senderAuthenticated from a live macp-runtime (integration)', () => {
  let ctx: TestAppContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ServiceCtor: any;
  let SessionStartPayload: protobuf.Type;
  let SignalPayload: protobuf.Type;
  const savedEnv: Record<string, string | undefined> = {};
  let sessionId: string | undefined;

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

  async function send(envelope: Record<string, unknown>): Promise<void> {
    const res = await agentCall('Send', {
      envelope: {
        macpVersion: '1.0',
        messageId: randomUUID(),
        sender: AGENT.sender,
        timestampUnixMs: Date.now(),
        ...envelope
      }
    });
    expect(res?.ack?.ok).toBe(true);
  }

  beforeAll(async () => {
    overrideEnv('SESSION_DISCOVERY_ENABLED', 'true');
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
    SignalPayload = root.lookupType('macp.v1.SignalPayload');
  }, 90000);

  afterAll(async () => {
    if (sessionId)
      await agentCall('CancelSession', { sessionId, reason: 'signal-auth cleanup' }).catch(() => undefined);
    if (ctx) await ctx.app.close();
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }, 90000);

  it(`persists signal.emitted with senderAuthenticated: ${authenticated}`, async () => {
    sessionId = randomUUID();
    const base = decisionModeRequest();
    const body: RunDescriptor = {
      ...base,
      session: { ...base.session, sessionId, ttlMs: 120000, participants: [{ id: AGENT.sender }] }
    };
    const { runId } = await ctx.client.createRun(body);

    await send({
      mode: body.session.modeName,
      messageType: 'SessionStart',
      sessionId,
      payload: Buffer.from(
        SessionStartPayload.encode(
          SessionStartPayload.create({
            intent: 'signal senderAuthenticated verification',
            participants: SESSION_PARTICIPANTS,
            modeVersion: body.session.modeVersion,
            configurationVersion: body.session.configurationVersion,
            ttlMs: 120000
          })
        ).finish()
      )
    });
    await waitFor(
      async () => {
        const run = (await ctx.client.getRun(runId)) as any;
        return run.status === 'running' ? run : null;
      },
      { timeoutMs: 20000, label: 'run running' }
    );

    // Ambient signal: empty mode and sessionId, correlated through the payload.
    await send({
      mode: '',
      messageType: 'Signal',
      sessionId: '',
      payload: Buffer.from(
        SignalPayload.encode(
          SignalPayload.create({ signalType: 'phase5.auth-check', confidence: 0.5, correlationSessionId: sessionId })
        ).finish()
      )
    });

    const signal = await waitFor(
      async () => {
        const events = (await ctx.client.listEvents(runId)) as any[];
        return events.find((e) => e.type === 'signal.emitted') ?? null;
      },
      { timeoutMs: 15000, label: 'signal.emitted persisted' }
    );
    expect(signal.data.senderAuthenticated).toBe(authenticated);
    expect(signal.data.sender).toBe(AGENT.sender);

    // The projection the console's signal rail reads carries it too.
    const state = (await ctx.client.getState(runId)) as any;
    const entry = state.signals.signals.find((s: any) => s.name === 'phase5.auth-check');
    expect(entry?.senderAuthenticated).toBe(authenticated);
  }, 60000);
});
