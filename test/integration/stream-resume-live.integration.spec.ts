import * as net from 'node:net';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as protobuf from 'protobufjs';
import { describeWithRealRuntime } from '../helpers/real-runtime-gate';
import { createTestApp, TestAppContext } from '../helpers/test-app';
import { decisionModeRequest } from '../fixtures/decision-mode';
import { waitFor } from '../helpers/wait-for';
import { RunDescriptor } from '../../src/contracts/control-plane';
import { DatabaseService } from '../../src/db/database.service';
import { RuntimeProviderRegistry } from '../../src/runtime/runtime-provider.registry';

/**
 * Phase 5 of plans/absorb-runtime-v0.7.0.md — live re-verification of the
 * control-plane's stream-resume/ordinal contract against a REAL macp-runtime
 * 0.7.0, not `ScriptedMockRuntimeProvider`. The mock re-implements the
 * `after_sequence` skip rule itself (`test/helpers/scripted-mock-runtime.provider.ts`),
 * so every other stream-resume test in this repo validates the control-plane
 * against the control-plane team's own model of the contract. This spec is
 * the one place that asks the *runtime* what the right answer is.
 *
 * Gated with `describeWithRealRuntime` — skipped (not failed) unless
 * `INTEGRATION_RUNTIME` selects a real gRPC runtime (CI pins `mock`).
 *
 * The control-plane is a pure observer throughout: it never calls `Send`
 * (guarded separately by `src/runtime/observer-invariant.spec.ts`, untouched
 * here). All envelopes are emitted by a raw gRPC client playing the AGENT
 * role, constructed inline below — mirroring the approach validated in
 * Phase 1's scratchpad seeder, not by depending on any scratchpad path at
 * runtime.
 *
 * ── Seams used ──────────────────────────────────────────────────────────
 *  Criteria 1 + 2 (exactly-once across a break, invariant 6 proven live):
 *  seam (a) from the plan — the real macp-runtime *process* is restarted
 *  mid-session (graceful signal, wait for exit, relaunch, wait for the port).
 *  This is the only seam that exercises the actual cross-process resume path
 *  P4 changed: the control-plane's stream errors for real, and its own
 *  error+backoff+resubscribe code in `StreamConsumerService` runs unmodified.
 *
 *  IMPORTANT caveat on "graceful": macp-runtime's only registered shutdown
 *  hook is `tokio::signal::ctrl_c()` (confirmed by inspecting
 *  `../macp-runtime/src/main.rs` — there is no `SignalKind::terminate()`
 *  handler anywhere in the crate), which is SIGINT, not SIGTERM. Sending
 *  SIGTERM to this binary does NOT run its drain/persist path — Rust's
 *  default disposition just kills it. This spec sends SIGINT to get the
 *  actually-graceful shutdown the plan asks for ("not kill -9 mid-persist").
 *
 *  Criterion 3 (resume below a compacted base → session.stream.gap):
 *  compaction only runs when a session terminates (`maybe_compact_log` in
 *  `../macp-runtime/src/runtime.rs:975-977`, called from `:722` and `:831`),
 *  and it discards all history strictly before the session's final accepted
 *  ordinal. The seam that actually forces it live is the dedicated
 *  `CancelSession` RPC — a `SessionCancel` sent as a `Send` envelope is
 *  rejected `Forbidden`, which is what made an earlier revision of this
 *  spec's empirical test time out (it never induced compaction at all). With
 *  `CancelSession` driving the session terminal, a resubscribe below the
 *  compacted base IS rejected live, but not as a stream-ending
 *  `FAILED_PRECONDITION`: `../macp-runtime/src/server.rs` downgrades it to a
 *  non-terminal inline `StreamSessionResponse.error` frame (`code` set to
 *  `status.message().to_string()` — the human message, not a status name)
 *  and leaves the bidi stream open, because `is_stream_terminal_error`
 *  (~line 745-755) unconditionally excludes `FailedPrecondition` from the
 *  small set of codes allowed to end a `StreamSession` stream
 *  (server.rs:608-628). Part 1 below proves that half live, straight off the
 *  wire.
 *
 *  Part 2 proves the control-plane side, now that two production fixes are
 *  in place on this branch:
 *   (1) `RustRuntimeProvider.subscribeSession()`
 *       (`src/runtime/rust-runtime.provider.ts:268-280`) no longer treats
 *       proto-loader's oneof-discriminant STRING (`chunk.response ===
 *       'error'`) as the payload — a non-empty string is truthy, so the old
 *       `chunk.response ?? chunk` picked the string every time and silently
 *       dropped the frame. It now only treats `chunk.response` as the
 *       payload holder when it is a genuine object, falling through to the
 *       flat `chunk.error`/`chunk.envelope` shape otherwise — so the inline
 *       frame reaches `StreamConsumerService` as a `kind:
 *       'stream-inline-error'` `RawRuntimeEvent` instead of vanishing. Part
 *       1 proves this directly, live, against the real provider.
 *   (2) `StreamConsumerService`'s consume loop matches that inline frame's
 *       message/code against `isCompactedHistoryError` (/compact/i), emits
 *       `session.stream.gap`, flags the projection's `historyGap`, and
 *       degrades to poll-only instead of resubscribing from 0 (the CP has no
 *       message-id dedup, so a from-0 resubscribe would re-ingest history).
 *  Part 2 forces this live with a second, dedicated app instance (its own
 *  `STREAM_IDLE_TIMEOUT_MS`/`STREAM_BACKOFF_*`, tuned the opposite way from
 *  criteria 1+2's restart-sized values — see that test's block comment for
 *  why the shared `ctx`'s timing is wrong for this purpose): a real
 *  in-progress run's per-session stream is allowed to go idle on its own, so
 *  the control-plane's *own* reconnect logic — not a test-injected
 *  disconnect — is what resubscribes from its last delivered envelope
 *  ordinal while the session is being cancelled and compacted out from
 *  under it during that idle window. `session.stream.gap`, projection
 *  `historyGap`, and "never resubscribes from ordinal 0" are then asserted
 *  against the real Postgres-backed canonical event log and projection, and
 *  against a spy on `provider.subscribeSession()`'s actual call arguments —
 *  not inferred from reading the code.
 *
 * ── Runtime auth finding (absorption finding, not a test defect) ──────────
 *  The control-plane's dev-bearer identity can NEVER observe a session
 *  started by another agent under macp-runtime's insecure/no-token-file dev
 *  mode:
 *   - `../macp-runtime/src/server.rs` (session-access authorization) allows
 *     a caller only when `identity.is_observer || session.initiator_sender
 *     == identity.sender || session.participants.contains(identity.sender)`.
 *   - `../macp-runtime/crates/macp-auth/src/security.rs` `dev_authenticate`
 *     — the path taken under `MACP_ALLOW_INSECURE=1` with NO
 *     `MACP_AUTH_TOKENS_FILE` configured — hardcodes `is_observer: false`.
 *     `is_observer: true` is only ever produced from a *configured* token
 *     entry (`RawIdentity` in the same file).
 *  So a CP presenting an arbitrary dev bearer is neither the initiator nor a
 *  declared participant of a session some other agent started, and every
 *  `GetSession`/`StreamSession` call fails `FORBIDDEN: session access
 *  denied` (gRPC code 7). This is why this spec requires the runtime to be
 *  started with a configured `MACP_AUTH_TOKENS_FILE` containing an
 *  `is_observer: true` entry for the control-plane's bearer, e.g.:
 *    { "tokens": [
 *        { "token": "cp-observer-token", "sender": "macp-control-plane", "is_observer": true, "can_start_sessions": false },
 *        { "token": "agent-alpha-token", "sender": "agent-alpha", "can_start_sessions": true },
 *        { "token": "agent-beta-token",  "sender": "agent-beta",  "can_start_sessions": true }
 *      ] }
 *  Start the runtime with (still needs MACP_ALLOW_INSECURE=1 -- that only
 *  waives TLS, it does not disable configured tokens):
 *    MACP_ALLOW_INSECURE=1 MACP_AUTH_TOKENS_FILE=<path-to-file-above> \
 *      MACP_BIND_ADDR=127.0.0.1:50051 RUST_LOG=info ./target/debug/macp-runtime
 *  This spec sets RUNTIME_BEARER_TOKEN=cp-observer-token itself (below) so
 *  it does not depend on the operator's shell environment; the two
 *  agent-*-token bearers are used directly by this file's raw gRPC agent
 *  client. If the runtime is restarted (seam (a) below) with a different
 *  data dir or tokens file than the one it's already running with, set
 *  MACP_RUNTIME_DATA_DIR / MACP_RUNTIME_AUTH_TOKENS_FILE before running
 *  this spec so the relaunch preserves them.
 */

const RUNTIME_ADDRESS = process.env.RUNTIME_ADDRESS ?? '127.0.0.1:50051';
const RUNTIME_DIR = process.env.MACP_RUNTIME_DIR ?? path.resolve(__dirname, '../../../macp-runtime');
const RUNTIME_BINARY = path.join(RUNTIME_DIR, 'target/debug/macp-runtime');
const RUNTIME_RESTART_LOG = path.join(RUNTIME_DIR, '.phase5-live-restart.log');
const RUNTIME_PORT = 50051;
// Optional: preserved across a forced restart (seam (a)) so a runtime already
// running with a non-default data dir / configured auth-tokens file (see the
// "Runtime auth finding" note above) comes back up the same way instead of
// silently reverting to no-token-file dev mode.
const RUNTIME_DATA_DIR_OVERRIDE = process.env.MACP_RUNTIME_DATA_DIR;
const RUNTIME_AUTH_TOKENS_FILE_OVERRIDE = process.env.MACP_RUNTIME_AUTH_TOKENS_FILE;

/**
 * The two agent identities this spec is allowed to emit as. Under a
 * configured MACP_AUTH_TOKENS_FILE the runtime authenticates by looking up
 * the presented bearer token in its token table and uses THAT entry's
 * `sender` as the authoritative identity -- an envelope's own `sender` field
 * must either be empty or match it exactly, or the runtime rejects it
 * (../macp-runtime/src/server.rs). So, unlike a no-token-file dev runtime
 * (which accepts any bearer value as its own sender), this spec cannot
 * invent arbitrary sender names like "proposer"/"evaluator"/"voter" -- it
 * can only act as whichever identities the runtime's token file defines.
 */
const AGENT_ALPHA = { token: 'agent-alpha-token', sender: 'agent-alpha' };
const AGENT_BETA = { token: 'agent-beta-token', sender: 'agent-beta' };
const CP_OBSERVER_TOKEN = 'cp-observer-token';

// ── Raw gRPC "agent" client — plays the role macp-sdk-python/typescript play in
// production. The control-plane must NEVER construct this; this file is a test
// fixture, not application code, and never calls provider.send() anywhere. ──

function loadProtoDir(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { protoDir } = require('@multiagentcoordinationprotocol/proto');
  return protoDir as string;
}

function makeAgentServiceClient(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const protoDir = loadProtoDir();
  const pkgDef = protoLoader.loadSync(
    ['macp/v1/core.proto', 'macp/v1/envelope.proto', 'macp/v1/policy.proto'],
    { keepCase: false, longs: String, enums: String, defaults: true, oneofs: true, includeDirs: [protoDir] }
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const descriptor = grpc.loadPackageDefinition(pkgDef) as any;
  return descriptor.macp.v1.MACPRuntimeService;
}

interface PayloadTypes {
  SessionStartPayload: protobuf.Type;
  CommitmentPayload: protobuf.Type;
  ProposalPayload: protobuf.Type;
  EvaluationPayload: protobuf.Type;
  VotePayload: protobuf.Type;
}

async function loadPayloadTypes(): Promise<PayloadTypes> {
  const protoDir = loadProtoDir();
  const root = new protobuf.Root();
  root.resolvePath = (_origin: string, target: string) =>
    target.startsWith('/') ? target : path.join(protoDir, target);
  await root.load(['macp/v1/core.proto', 'macp/modes/decision/v1/decision.proto']);
  return {
    SessionStartPayload: root.lookupType('macp.v1.SessionStartPayload'),
    CommitmentPayload: root.lookupType('macp.v1.CommitmentPayload'),
    ProposalPayload: root.lookupType('macp.modes.decision.v1.ProposalPayload'),
    EvaluationPayload: root.lookupType('macp.modes.decision.v1.EvaluationPayload'),
    VotePayload: root.lookupType('macp.modes.decision.v1.VotePayload')
  };
}

interface SendResult {
  ok: boolean;
  error?: unknown;
}

interface AgentIdentity {
  token: string;
  sender: string;
}

function sendOnce(
  ServiceCtor: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  opts: { sessionId: string; agent: AgentIdentity; messageType: string; messageId: string; payload: Uint8Array }
): Promise<SendResult> {
  return new Promise((resolve, reject) => {
    const client = new ServiceCtor(RUNTIME_ADDRESS, grpc.credentials.createInsecure());
    const md = new grpc.Metadata();
    // Authenticate as the configured token, not an arbitrary bearer — see the
    // "Runtime auth finding" note in the file header. `envelope.sender` must
    // match the token's mapped sender exactly (or be omitted).
    md.set('authorization', `Bearer ${opts.agent.token}`);
    client.Send(
      {
        envelope: {
          macpVersion: '1.0',
          mode: 'macp.mode.decision.v1',
          messageType: opts.messageType,
          messageId: opts.messageId,
          sessionId: opts.sessionId,
          sender: opts.agent.sender,
          timestampUnixMs: Date.now(),
          payload: Buffer.from(opts.payload)
        }
      },
      md,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (err: any, res: any) => {
        client.close();
        if (err) return reject(err);
        resolve({ ok: res?.ack?.ok === true, error: res?.ack?.error });
      }
    );
  });
}

/**
 * Send an envelope as the agent role, retrying only on transient
 * "runtime not accepting connections yet" errors (expected for a few hundred
 * ms right after `restartRuntimeGracefully()`). Any other error — a real
 * protocol/validation rejection — surfaces immediately.
 */
async function sendEnvelope(
  ServiceCtor: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  opts: { sessionId: string; agent: AgentIdentity; messageType: string; messageId: string; payload: Uint8Array }
): Promise<SendResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return await sendOnce(ServiceCtor, opts);
    } catch (err) {
      lastErr = err;
      const code = (err as { code?: number } | undefined)?.code;
      const message = err instanceof Error ? err.message : String(err);
      const transient = code === 14 /* UNAVAILABLE */ || /ECONNREFUSED|UNAVAILABLE/i.test(message);
      if (!transient) throw err;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw lastErr;
}

/**
 * CancelSession as the agent role — a Core control-plane RPC (RFC-MACP-0001
 * §7.2/§7.3), restricted to the session initiator or a policy-delegated
 * role. Used only by the raw agent client in this file, never by the
 * control-plane (which would violate the observer invariant).
 */
function sendCancel(
  ServiceCtor: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  sessionId: string,
  agent: AgentIdentity,
  reason = 'phase5 criterion-3 verification'
): Promise<SendResult> {
  return new Promise((resolve, reject) => {
    const client = new ServiceCtor(RUNTIME_ADDRESS, grpc.credentials.createInsecure());
    const md = new grpc.Metadata();
    md.set('authorization', `Bearer ${agent.token}`);
    client.CancelSession(
      { sessionId, reason },
      md,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (err: any, res: any) => {
        client.close();
        if (err) return reject(err);
        resolve({ ok: res?.ack?.ok === true, error: res?.ack?.error });
      }
    );
  });
}

// ── Runtime process control (seam (a): restart the real macp-runtime) ──

function findListeningPid(port: number): number | null {
  try {
    const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf8' }).trim();
    if (!out) return null;
    const first = out.split('\n')[0];
    const pid = parseInt(first, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // ESRCH — process is gone
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`macp-runtime pid ${pid} did not exit within ${timeoutMs}ms after SIGINT`);
}

async function waitForPortOpen(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port }, () => {
        sock.end();
        resolve(true);
      });
      sock.on('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`macp-runtime did not start listening on 127.0.0.1:${port} within ${timeoutMs}ms`);
}

function spawnRuntime(): void {
  const fd = fs.openSync(RUNTIME_RESTART_LOG, 'a');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MACP_ALLOW_INSECURE: '1',
    MACP_BIND_ADDR: `127.0.0.1:${RUNTIME_PORT}`,
    RUST_LOG: 'info'
  };
  // Preserve a non-default data dir / configured auth-tokens file across the
  // restart (see file header) instead of silently reverting to no-token-file
  // dev mode, which would break every subsequent GetSession/StreamSession call.
  if (RUNTIME_DATA_DIR_OVERRIDE) env.MACP_DATA_DIR = RUNTIME_DATA_DIR_OVERRIDE;
  if (RUNTIME_AUTH_TOKENS_FILE_OVERRIDE) env.MACP_AUTH_TOKENS_FILE = RUNTIME_AUTH_TOKENS_FILE_OVERRIDE;
  const child = spawn(RUNTIME_BINARY, [], {
    cwd: RUNTIME_DIR,
    env,
    detached: true,
    stdio: ['ignore', fd, fd]
  });
  child.unref();
}

/**
 * Force a clean stream break by restarting the real runtime process:
 * SIGINT (the binary's only graceful-shutdown signal — see file header),
 * wait for actual exit, relaunch from the same binary/data dir, wait for the
 * port to accept connections again. Leaves the runtime running on
 * 127.0.0.1:50051 when it returns, per the phase's hard constraint.
 */
async function restartRuntimeGracefully(): Promise<void> {
  const pid = findListeningPid(RUNTIME_PORT);
  if (!pid) {
    throw new Error(
      `no process found listening on 127.0.0.1:${RUNTIME_PORT} — cannot exercise the restart seam. ` +
        `Expected the live macp-runtime 0.7.0 described in the phase brief to already be running.`
    );
  }
  process.kill(pid, 'SIGINT');
  await waitForProcessExit(pid, 20000);
  spawnRuntime();
  await waitForPortOpen(RUNTIME_PORT, 20000);
}

/** Safety net for afterAll: if the runtime isn't listening, relaunch it once more. */
async function ensureRuntimeListening(): Promise<void> {
  if (findListeningPid(RUNTIME_PORT)) return;
  spawnRuntime();
  await waitForPortOpen(RUNTIME_PORT, 20000);
}

// ── Canonical-event-log assertions (direct Postgres queries, per the plan) ──

async function fetchMessageIds(pool: { query: (q: string, p: unknown[]) => Promise<{ rows: { mid: string }[] }> }, runId: string): Promise<string[]> {
  const res = await pool.query(
    `SELECT data->>'messageId' AS mid FROM run_events_canonical WHERE run_id = $1 AND type = 'message.received' ORDER BY seq ASC`,
    [runId]
  );
  return res.rows.map((r) => r.mid);
}

describeWithRealRuntime('Stream resume — live macp-runtime 0.7.0 (Phase 5)', () => {
  let ctx: TestAppContext;
  let payloadTypes: PayloadTypes;
  let ServiceCtor: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const savedEnv: Record<string, string | undefined> = {};

  function overrideEnv(name: string, value: string): void {
    savedEnv[name] = process.env[name];
    process.env[name] = value;
  }

  beforeAll(async () => {
    // Give the in-process reconnect loop a generous, fast-cycling budget so a
    // ~10-12s runtime restart (macp-runtime's drain waits out
    // MACP_SHUTDOWN_DRAIN_SECS, default 10s, while our passive-subscribe
    // stream is still open) comfortably fits inside the retry budget instead
    // of exhausting it and degrading straight to poll-only, which would
    // prove nothing about the stream-resume path this phase re-verifies.
    overrideEnv('STREAM_MAX_RETRIES', '30');
    overrideEnv('STREAM_BACKOFF_BASE_MS', '250');
    overrideEnv('STREAM_BACKOFF_MAX_MS', '2000');
    // The shared runtime currently holds ~300 live sessions seeded by earlier
    // phases. SESSION_DISCOVERY_ENABLED defaults to true
    // (src/config/app-config.service.ts), and SessionDiscoveryService's
    // WatchSessions initial sync auto-creates a run + a per-session
    // StreamSession for every one of them — hundreds of concurrent streams
    // that then make ctx.cleanup()'s drain (and app.close()'s drain) exceed
    // any reasonable hook timeout. This spec only needs the CP to observe
    // the one session it drives via POST /runs (RunExecutor's own
    // GetSession-poll -> bind -> subscribe path), which does not depend on
    // discovery at all, so discovery is switched off for this app instance.
    overrideEnv('SESSION_DISCOVERY_ENABLED', 'false');
    // Required per the "Runtime auth finding" note above: the runtime must be
    // started with a configured MACP_AUTH_TOKENS_FILE containing an
    // is_observer:true entry for this exact token, or every GetSession /
    // StreamSession call this app makes fails FORBIDDEN (gRPC code 7). Set
    // here (not left to the operator's shell) so the spec is reproducible.
    overrideEnv('RUNTIME_BEARER_TOKEN', CP_OBSERVER_TOKEN);

    ctx = await createTestApp();
    payloadTypes = await loadPayloadTypes();
    ServiceCtor = makeAgentServiceClient();
  }, 90000);

  afterAll(async () => {
    await ctx.app.close();
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    // Hard constraint: leave the runtime running on 127.0.0.1:50051.
    await ensureRuntimeListening();
  }, 90000);

  beforeEach(async () => {
    await ctx.cleanup();
  }, 90000);

  it(
    'criteria 1+2: exactly-once ingestion and invariant-6 delivery across a forced live runtime restart',
    async () => {
      const database = ctx.module.get(DatabaseService);
      const sessionId = randomUUID();
      const base = decisionModeRequest();
      const body: RunDescriptor = {
        ...base,
        session: {
          ...base.session,
          sessionId,
          ttlMs: 300000,
          // Only agent-alpha/agent-beta are usable senders under the
          // configured auth-tokens file — see the file header.
          participants: [{ id: AGENT_ALPHA.sender }, { id: AGENT_BETA.sender }]
        }
      };

      const { runId } = await ctx.client.createRun(body);
      const sentIds: string[] = [];

      // ── SessionStart (the agent opens the session the CP pre-allocated) ──
      const startId = randomUUID();
      const startPayload = payloadTypes.SessionStartPayload.encode(
        payloadTypes.SessionStartPayload.create({
          intent: 'phase5 live stream-resume verification',
          participants: body.session.participants.map((p) => p.id),
          modeVersion: body.session.modeVersion,
          configurationVersion: body.session.configurationVersion,
          ttlMs: 300000
        })
      ).finish();
      const startResult = await sendEnvelope(ServiceCtor, {
        sessionId,
        agent: AGENT_ALPHA,
        messageType: 'SessionStart',
        messageId: startId,
        payload: startPayload
      });
      expect(startResult.ok).toBe(true);
      sentIds.push(startId);

      // ── Wait for the CP to bind + subscribe. `running` is set immediately
      // after `provider.subscribeSession()` returns — i.e. after the single
      // passive-subscribe frame has been written (RFC-MACP-0006 §3.2) —
      // which is the precise moment invariant 6 ("write side stays open
      // after the subscribe frame") becomes provable: anything sent from
      // here on is provably "after the subscribe frame", not replayed
      // history. ──
      await waitFor(
        async () => {
          const run = (await ctx.client.getRun(runId)) as any;
          return run.status === 'running' ? run : null;
        },
        { timeoutMs: 20000, label: 'run bound and subscribed (running)' }
      );

      const sendProposal = async (id: string, proposalId: string) => {
        const payload = payloadTypes.ProposalPayload.encode(
          payloadTypes.ProposalPayload.create({
            proposalId,
            option: `option for ${proposalId}`,
            rationale: 'phase5 live verification envelope'
          })
        ).finish();
        const result = await sendEnvelope(ServiceCtor, {
          sessionId,
          agent: AGENT_ALPHA,
          messageType: 'Proposal',
          messageId: id,
          payload
        });
        expect(result.ok).toBe(true);
        sentIds.push(id);
      };

      // ── Batch A: sent strictly after the subscribe frame was written,
      // strictly before the runtime restart. Their arrival is the live proof
      // of invariant 6. ──
      const BATCH_A = 5;
      for (let i = 0; i < BATCH_A; i++) {
        await sendProposal(randomUUID(), `prop-live-a-${i}`);
      }

      await waitFor(
        async () => {
          const ids = await fetchMessageIds(database.pool, runId);
          return sentIds.every((id) => ids.includes(id)) ? ids : null;
        },
        { timeoutMs: 15000, label: 'batch A ingested (invariant 6 proof)' }
      );

      // ── Invariant 6, asserted explicitly: every batch-A envelope, sent
      // only after the run reached `running` (i.e. after the one subscribe
      // frame), was delivered — proving the write side stayed open and the
      // runtime kept broadcasting to a passive subscriber. ──
      const afterBatchA = await fetchMessageIds(database.pool, runId);
      for (const id of sentIds) {
        expect(afterBatchA.filter((x) => x === id)).toHaveLength(1);
      }

      // ── Force a clean stream break: restart the real runtime process
      // mid-session (seam (a) — see file header for why SIGINT, not
      // SIGTERM, is this binary's graceful path). ──
      await restartRuntimeGracefully();

      // ── Batch B: sent only after the restart. Their eventual arrival
      // proves the cross-process resume path (P4) actually ran against the
      // real runtime's ordinal semantics, not the mock's. ──
      const BATCH_B = 5;
      for (let i = 0; i < BATCH_B; i++) {
        await sendProposal(randomUUID(), `prop-live-b-${i}`);
      }

      await waitFor(
        async () => {
          const ids = await fetchMessageIds(database.pool, runId);
          return sentIds.every((id) => ids.includes(id)) ? ids : null;
        },
        { timeoutMs: 45000, label: 'batch B ingested after runtime restart (resume proof)' }
      );

      // ── Exactly-once, asserted on the canonical event log in Postgres:
      // every one of the 11 sent envelopes (SessionStart + 10 Proposals)
      // appears exactly once — no duplicates (which a naive from-0
      // resubscribe would produce, since the CP has no message-id dedup —
      // see CLAUDE.md's stream-resume section) and no gaps. ──
      const finalIds = await fetchMessageIds(database.pool, runId);
      expect(new Set(finalIds)).toEqual(new Set(sentIds));
      expect(finalIds).toHaveLength(sentIds.length);
      for (const id of sentIds) {
        expect(finalIds.filter((x) => x === id)).toHaveLength(1);
      }
    },
    120000
  );

  /**
   * Criterion 3, part 1 (live, passing) — supersedes two earlier, now
   * obsolete, revisions of this spec: an "empirical" test that hung for 30s
   * because it never actually forced compaction (cancelling via a `Send`
   * envelope is rejected `Forbidden`; the fix is to drive termination through
   * the dedicated `CancelSession` RPC instead), and a `.skip`ped test whose
   * "cannot fire" premise was never actually checked against the real
   * `RustRuntimeProvider` code path.
   *
   * This test proves, live, both:
   *
   *  (a) The runtime's rejection of a stale resume against a compacted
   *      session is a non-terminal inline frame, NOT a stream-ending gRPC
   *      `FAILED_PRECONDITION`. Traced in `../macp-runtime/src/server.rs`:
   *        - `process_subscribe_frame` (~line 456) builds the rejection as
   *          `Status::failed_precondition(...)` when
   *          `get_session_envelopes_after` reports the requested ordinal is
   *          below the compacted base.
   *        - `build_stream_session_stream`'s generator (~line 524) only lets
   *          an error terminate the stream (`Err(status)?`) when
   *          `is_stream_terminal_error(&status)` (~line 745) is true — and
   *          that function's fixed list is `Unauthenticated | Internal |
   *          ResourceExhausted | InvalidArgument | NotFound | AlreadyExists`.
   *          `FailedPrecondition` is not in it, unconditionally, for any
   *          caller.
   *        - Every other `Err(status)` (~line 609-627) is instead downgraded
   *          to a non-terminal `StreamSessionResponse.error` (`PbMacpError`)
   *          frame — `code` set to `status.message().to_string()`, the human
   *          message, not a status name — and the stream stays open. This is
   *          the SAME delivery mechanism the runtime already uses for
   *          ordinary in-session validation errors (PolicyDenied,
   *          InvalidPayload — see this repo's CLAUDE.md "Stream inline
   *          errors" note); the compacted-resume rejection is simply
   *          included in that same non-terminal category, by design.
   *      Asserted directly off the wire via a raw gRPC client (matching the
   *      hand-verified recipe this phase was handed, not `provider
   *      .subscribeSession()` — see (b) for why): the compaction frame
   *      arrives as ordinary stream `data`, the stream is still open several
   *      seconds later (no `error`/`end`).
   *
   *  (b) That `RustRuntimeProvider.subscribeSession()` now correctly
   *      surfaces that same frame as a `kind: 'stream-inline-error'`
   *      `RawRuntimeEvent` — the fix that makes criterion 3 part 2 (below)
   *      observable at all. Before the fix, its `data` handler
   *      (`src/runtime/rust-runtime.provider.ts`) did
   *      `const responseBody = chunk.response ?? chunk; if
   *      (responseBody.error) {...}`. Proto-loader's `oneofs: true` option
   *      (used identically by this file's raw client, so the comparison is
   *      apples-to-apples) adds a discriminant property *also named*
   *      `response` holding the STRING naming which oneof case is
   *      populated. For this exact frame that string is `'error'` — truthy
   *      — so `chunk.response ?? chunk` picked the *string*,
   *      `responseBody.error` was therefore always `undefined`, and the
   *      following `rawEnvelope = responseBody.envelope ?? chunk.envelope`
   *      also came up empty, so the handler's `if (!rawEnvelope) return;`
   *      silently dropped the frame before it ever became a
   *      `RawRuntimeEvent`. The fix
   *      (`src/runtime/rust-runtime.provider.ts:268-280`) only treats
   *      `chunk.response` as the payload holder when it is a genuine
   *      object, falling through to the flat `chunk` shape — where
   *      `chunk.error`/`chunk.envelope` actually live — whenever
   *      `chunk.response` is instead that discriminant string.
   *      Asserted two ways, both live: first, decoding the identical wire
   *      frame from (a) with the same loader options and checking
   *      `typeof frame.response === 'string'` (the root cause — the wire
   *      shape didn't change, only how the provider reads it). Second — so
   *      this isn't just an inference about code paths — calling the REAL
   *      `provider.subscribeSession()` on the same compacted session and
   *      confirming its iterator's next real item, after the synthetic
   *      "opened" marker, IS this frame, decoded as `kind:
   *      'stream-inline-error'` with the compaction message intact.
   *
   * See criterion 3 part 2 below for the control-plane-level proof this fix
   * unblocks: `session.stream.gap` emitted, the projection flagged
   * `historyGap`, and the consumer degrading to poll-only without ever
   * resubscribing from ordinal 0.
   */
  it(
    'criterion 3, part 1 (live): the runtime rejects a stale resume against a compacted session as a non-terminal inline frame — and RustRuntimeProvider.subscribeSession() now correctly surfaces it as a stream-inline-error event (see block comment above for exact server.rs + rust-runtime.provider.ts citations)',
    async () => {
      const provider = ctx.module.get(RuntimeProviderRegistry).get('rust');
      const sessionId = randomUUID();

      const startPayload = payloadTypes.SessionStartPayload.encode(
        payloadTypes.SessionStartPayload.create({
          intent: 'phase5 live criterion-3 proof',
          participants: [AGENT_ALPHA.sender, AGENT_BETA.sender],
          modeVersion: '1.0.0',
          configurationVersion: '1.0.0',
          ttlMs: 300000
        })
      ).finish();
      const startResult = await sendEnvelope(ServiceCtor, {
        sessionId,
        agent: AGENT_ALPHA,
        messageType: 'SessionStart',
        messageId: randomUUID(),
        payload: startPayload
      });
      if (!startResult.ok) throw new Error(`SessionStart rejected: ${JSON.stringify(startResult.error)}`);

      const proposalPayload = payloadTypes.ProposalPayload.encode(
        payloadTypes.ProposalPayload.create({
          proposalId: 'prop-criterion3',
          option: 'Deploy the criterion-3 feature',
          rationale: 'criterion 3 live proof'
        })
      ).finish();
      const proposalResult = await sendEnvelope(ServiceCtor, {
        sessionId,
        agent: AGENT_ALPHA,
        messageType: 'Proposal',
        messageId: randomUUID(),
        payload: proposalPayload
      });
      if (!proposalResult.ok) throw new Error(`Proposal rejected: ${JSON.stringify(proposalResult.error)}`);

      // CancelSession as agent-alpha, the initiator — a Core control-plane
      // RPC (RFC-MACP-0001 §7.2/§7.3), sent by the AGENT here, never the CP
      // (which would violate the observer invariant). This is what actually
      // drives the session terminal and triggers compaction
      // (`maybe_compact_log`, `../macp-runtime/src/runtime.rs:975-977`) — a
      // `SessionCancel` sent as a `Send` envelope is rejected `Forbidden`.
      const cancelResult = await sendCancel(ServiceCtor, sessionId, AGENT_ALPHA);
      if (!cancelResult.ok) throw new Error(`CancelSession rejected: ${JSON.stringify(cancelResult.error)}`);

      const cancelled = await waitFor(
        async () => {
          const snapshot = await provider.getSession({ runId: sessionId, runtimeSessionId: sessionId });
          return snapshot.state === 'SESSION_STATE_CANCELLED' ? snapshot : null;
        },
        { timeoutMs: 10000, label: 'session cancelled on the live runtime' }
      );
      expect(cancelled.state).toBe('SESSION_STATE_CANCELLED');

      // Compaction is server-side best-effort and asynchronous relative to the
      // CancelSession ack — there is no admin hook to observe "compaction
      // finished", so a short settle wait is unavoidable here (per the phase
      // brief). Everything else in this test sequences on observed state.
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // ── (a) Raw-runtime proof: resuming from a fresh subscribe (afterSequence
      // 0, now strictly below the compacted base) arrives as ordinary stream
      // `data`, not a thrown/terminal error, and the stream stays open. Uses a
      // raw client — not provider.subscribeSession() — with the SAME
      // proto-loader options (oneofs: true) RustRuntimeProvider itself uses in
      // onModuleInit(), so the wire-shape comparison in (b) is apples-to-apples. ──
      const observerClient = new ServiceCtor(RUNTIME_ADDRESS, grpc.credentials.createInsecure());
      const observerMd = new grpc.Metadata();
      observerMd.set('authorization', `Bearer ${CP_OBSERVER_TOKEN}`);
      const call = observerClient.StreamSession(observerMd);
      let streamEnded = false;
      let streamErrored: Error | null = null;
      call.on('end', () => {
        streamEnded = true;
      });
      call.on('error', (e: Error) => {
        streamErrored = e;
      });
      const firstFramePromise = new Promise<any>((resolve, reject) => {
        call.once('data', resolve);
        call.once('error', reject);
      });
      call.write({ subscribeSessionId: sessionId, afterSequence: 0 });
      const frame = await firstFramePromise;

      expect(frame.error).toBeDefined();
      expect(String(frame.error.message)).toMatch(/compact/i);

      // ── (b), first half — the empirical root cause: the SAME frame, decoded
      // with the SAME oneofs:true loader options RustRuntimeProvider uses,
      // carries `response` as the oneof-discriminant STRING, not the nested
      // response object `responseBody = chunk.response ?? chunk` expects. ──
      expect(typeof frame.response).toBe('string');
      expect(frame.response).toBe('error');

      // Confirm the stream is genuinely left open by the runtime (the
      // non-terminal half of the criterion) — no error/end within a settle
      // window after the rejection.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(streamEnded).toBe(false);
      expect(streamErrored).toBeNull();
      call.cancel();

      // ── (b), second half — the practical consequence, proven against the
      // REAL production method: subscribing via provider.subscribeSession()
      // on the same now-compacted session, the iterator's first real item
      // (after the synthetic "opened" marker) IS this frame, decoded as a
      // proper `stream-inline-error` RawRuntimeEvent, not silently dropped.
      // This is the fix that makes criterion 3 part 2 (below) observable. ──
      const probeHandle = provider.subscribeSession({ runId: sessionId, runtimeSessionId: sessionId, afterSequence: 0 });
      const probeIterator = probeHandle.events[Symbol.asyncIterator]();

      const opened = await probeIterator.next();
      expect(opened.done).toBe(false);
      expect(opened.value.kind).toBe('stream-status');

      const TIMEOUT = Symbol('timeout');
      const raced = await Promise.race([
        probeIterator.next(),
        new Promise((resolve) => setTimeout(() => resolve(TIMEOUT), 8000))
      ]);
      expect(raced).not.toBe(TIMEOUT);
      const secondItem = raced as { done: boolean; value: { kind: string; inlineError?: { message: string; code: string } } };
      expect(secondItem.done).toBe(false);
      expect(secondItem.value.kind).toBe('stream-inline-error');
      expect(String(secondItem.value.inlineError?.message)).toMatch(/compact/i);

      probeHandle.abort();
    },
    60000
  );

  /**
   * Criterion 3, part 2 (live) — the literal criterion from the phase brief:
   * with a real run in progress, force the control-plane's OWN reconnect
   * logic (not a test-injected disconnect) to resubscribe from its last
   * delivered envelope ordinal while the session has been cancelled and
   * compacted out from under it, and prove — against real Postgres-backed
   * projection and canonical event log — that:
   *   - a `session.stream.gap` canonical event is emitted for the run,
   *   - the projection is flagged `historyGap: true`,
   *   - the consumer degrades to poll-only and never resubscribes from
   *     ordinal 0 (0 only ever appears once — the initial bind-time
   *     subscribe — and the one reconnect attempt uses the real last
   *     delivered ordinal).
   *
   * This needs its own app instance (`ctx2`), not the shared `ctx`: criteria
   * 1+2 tunes `STREAM_BACKOFF_BASE_MS`/`STREAM_BACKOFF_MAX_MS` down to
   * 250/2000ms so its ~10-12s runtime-restart seam fits inside the retry
   * budget, but this test needs the OPPOSITE — a reconnect backoff long
   * enough to act (send an envelope + CancelSession + wait out compaction)
   * inside the window between the control-plane's stream going idle and it
   * actually attempting to resubscribe. It also needs a short
   * `STREAM_IDLE_TIMEOUT_MS` so that window opens quickly and
   * deterministically instead of waiting out the shared app's 120s default.
   *
   * Sequencing, all driven off observed state (no fixed sleeps beyond the
   * one unavoidable "compaction is best-effort and async" wait the phase
   * brief flags):
   *   1. POST /runs, SessionStart as agent-alpha → run reaches `running`
   *      (control-plane subscribes at afterSequence 0 — the one legitimate
   *      0, asserted below via a spy on `provider.subscribeSession()`).
   *   2. Wait for that SessionStart to be ingested (envelope ordinal 1),
   *      then wait out `STREAM_IDLE_TIMEOUT_MS` (+ margin) so the
   *      control-plane's own `withIdleTimeout` ends the stream and it starts
   *      its (long, tuned) reconnect backoff — a disconnect the
   *      control-plane initiated itself, not one this test injected.
   *   3. While the control-plane is asleep in that backoff: send one more
   *      Proposal (advances the runtime's ordinal past what the
   *      control-plane last recorded) and CancelSession as agent-alpha (the
   *      initiator) — the only RPC that actually drives the session terminal
   *      and triggers `maybe_compact_log`. Wait a few seconds for
   *      best-effort compaction, per the phase brief.
   *   4. The control-plane's backoff elapses; it resubscribes from its last
   *      delivered ordinal (1) — now strictly below the compacted base — and
   *      the inline compacted-history frame comes back on that very first
   *      frame, exactly as part 1 proved happens for any fresh subscribe at
   *      this point.
   *   5. Assert `session.stream.gap` + `historyGap` + the subscribe-call
   *      history, then confirm poll-only is a real, working fallback (not a
   *      dead end) by waiting for the run to reach its true terminal state
   *      (`cancelled`) via the poll loop's first `GetSession`, which already
   *      observes `SESSION_STATE_CANCELLED`.
   */
  it(
    'criterion 3, part 2 (live): a compacted-history reconnect emits session.stream.gap, flags the projection historyGap, and degrades to poll-only without ever resubscribing from ordinal 0',
    async () => {
      // ── Dedicated app instance with reconnect timing tuned for this
      // test's race (see block comment above for why the shared ctx's
      // timing is wrong for this purpose). ──
      const localSavedEnv: Record<string, string | undefined> = {};
      const setLocalEnv = (name: string, value: string) => {
        localSavedEnv[name] = process.env[name];
        process.env[name] = value;
      };
      setLocalEnv('STREAM_IDLE_TIMEOUT_MS', '2000');
      setLocalEnv('STREAM_BACKOFF_BASE_MS', '6000');
      setLocalEnv('STREAM_BACKOFF_MAX_MS', '12000');

      const ctx2 = await createTestApp();
      try {
        const database2 = ctx2.module.get(DatabaseService);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const provider = ctx2.module.get(RuntimeProviderRegistry).get('rust') as any;
        const originalSubscribe = provider.subscribeSession.bind(provider);
        const subscribeCalls: number[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        jest.spyOn(provider, 'subscribeSession').mockImplementation((req: any) => {
          subscribeCalls.push(req.afterSequence ?? 0);
          return originalSubscribe(req);
        });

        const sessionId = randomUUID();
        const base = decisionModeRequest();
        const body: RunDescriptor = {
          ...base,
          session: {
            ...base.session,
            sessionId,
            ttlMs: 300000,
            modeVersion: '1.0.0',
            configurationVersion: '1.0.0',
            participants: [{ id: AGENT_ALPHA.sender }, { id: AGENT_BETA.sender }]
          }
        };
        const { runId } = await ctx2.client.createRun(body);

        const startId = randomUUID();
        const startPayload = payloadTypes.SessionStartPayload.encode(
          payloadTypes.SessionStartPayload.create({
            intent: 'phase5 criterion-3 part-2 live proof',
            participants: body.session.participants.map((p) => p.id),
            modeVersion: body.session.modeVersion,
            configurationVersion: body.session.configurationVersion,
            ttlMs: 300000
          })
        ).finish();
        const startResult = await sendEnvelope(ServiceCtor, {
          sessionId,
          agent: AGENT_ALPHA,
          messageType: 'SessionStart',
          messageId: startId,
          payload: startPayload
        });
        expect(startResult.ok).toBe(true);

        await waitFor(
          async () => {
            const run = (await ctx2.client.getRun(runId)) as any;
            return run.status === 'running' ? run : null;
          },
          { timeoutMs: 20000, label: 'run bound and subscribed (running)' }
        );

        await waitFor(
          async () => {
            const ids = await fetchMessageIds(database2.pool, runId);
            return ids.includes(startId) ? ids : null;
          },
          { timeoutMs: 15000, label: 'SessionStart ingested (envelope ordinal 1)' }
        );

        // ── Let the control-plane's own stream go idle and reconnect on its
        // own (not a test-injected disconnect). Margin above
        // STREAM_IDLE_TIMEOUT_MS covers scheduling jitter. ──
        await new Promise((resolve) => setTimeout(resolve, 2000 + 1500));

        // ── While the control-plane is asleep in its (long) reconnect
        // backoff: advance the runtime past the control-plane's last known
        // ordinal, then drive the session terminal via CancelSession — the
        // only RPC that triggers compaction (a `SessionCancel` envelope is
        // rejected `Forbidden`, per the working recipe). ──
        const proposalPayload = payloadTypes.ProposalPayload.encode(
          payloadTypes.ProposalPayload.create({
            proposalId: 'prop-criterion3-part2',
            option: 'Deploy the criterion-3-part-2 feature',
            rationale: 'sent while the control-plane stream is deliberately idle/reconnecting'
          })
        ).finish();
        const proposalResult = await sendEnvelope(ServiceCtor, {
          sessionId,
          agent: AGENT_ALPHA,
          messageType: 'Proposal',
          messageId: randomUUID(),
          payload: proposalPayload
        });
        expect(proposalResult.ok).toBe(true);

        const cancelResult = await sendCancel(ServiceCtor, sessionId, AGENT_ALPHA);
        expect(cancelResult.ok).toBe(true);

        // Compaction is server-side best-effort and asynchronous relative to
        // the CancelSession ack — same unavoidable settle wait as part 1.
        await new Promise((resolve) => setTimeout(resolve, 3500));

        // ── The control-plane's reconnect backoff elapses on its own from
        // here; its resubscribe from ordinal 1 comes back compacted, exactly
        // as part 1 proved for a fresh subscribe at this point. Assert the
        // consequences against real Postgres state, not internal mocks. ──
        await waitFor(
          async () => {
            const res = await database2.pool.query(
              `SELECT 1 FROM run_events_canonical WHERE run_id = $1 AND type = 'session.stream.gap'`,
              [runId]
            );
            return res.rows.length > 0 ? res.rows : null;
          },
          { timeoutMs: 40000, label: 'session.stream.gap canonical event emitted' }
        );

        const state = (await ctx2.client.getState(runId)) as any;
        expect(state.run.historyGap).toBe(true);

        // ── Never resubscribes from ordinal 0: the ONLY 0 is the initial
        // bind-time subscribe; the one reconnect attempt uses the real last
        // delivered ordinal (1), and no further subscribeSession calls
        // happen after the gap is detected (it degrades to poll-only). ──
        expect(subscribeCalls[0]).toBe(0);
        expect(subscribeCalls.slice(1)).not.toContain(0);
        expect(subscribeCalls).toEqual([0, 1]);

        // ── The degrade is a real, working fallback, not a dead end: the
        // poll-only loop's first GetSession already observes
        // SESSION_STATE_CANCELLED and finalizes the run. ──
        await waitFor(
          async () => {
            const run = (await ctx2.client.getRun(runId)) as any;
            return run.status === 'cancelled' ? run : null;
          },
          { timeoutMs: 20000, label: 'run finalized cancelled via poll-only fallback' }
        );

        // historyGap must survive finalization, not just the transient gap window.
        const finalState = (await ctx2.client.getState(runId)) as any;
        expect(finalState.run.historyGap).toBe(true);
      } finally {
        jest.restoreAllMocks();
        await ctx2.app.close();
        for (const [name, value] of Object.entries(localSavedEnv)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    },
    90000
  );
});
