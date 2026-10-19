import { randomBytes, randomUUID } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as protobuf from 'protobufjs';
import { describeWithLocalRuntime } from '../helpers/real-runtime-gate';
import { createTestApp, TestAppContext } from '../helpers/test-app';
import { RuntimeProviderRegistry } from '../../src/runtime/runtime-provider.registry';
import { PolicyRulesValidatorService } from '../../src/policy/policy-rules-validator.service';
import { isValidSessionId } from '../../src/runs/run-executor.service';

/**
 * Admission parity against a REAL macp-runtime v0.9.0 (plans/macp-runtime-0.9.0-alignment.md,
 * Phase 4 AC3 + AC5). The control plane's pre-checks — `PolicyRulesValidatorService` on
 * `POST /runtime/policies` and `isValidSessionId` on `POST /runs` — exist to fail before the gRPC
 * round-trip with the runtime's own verdict. Unit tests check them against the CP's model of the
 * rules; this spec asks the runtime:
 *
 *  - AC3: each rule set goes straight to `provider.registerPolicy` (bypassing the CP check), and the
 *    runtime's accept/refuse verdict must equal the CP validator's, with `INVALID_POLICY_DEFINITION`
 *    on every refusal — parity, not CP-only strictness.
 *  - AC5: an agent sends `SessionStart` under each candidate session id; the runtime's verdict
 *    (`validate_session_id_for_acceptance`, crates/macp-core/src/session.rs:762-796) must equal
 *    `isValidSessionId`. The CP never sends (observer invariant); the raw agent client below plays
 *    the role macp-sdk plays in production.
 *
 * Gated like `stream-resume-live.integration.spec.ts` (`describeWithLocalRuntime`): needs
 * `INTEGRATION_RUNTIME=remote`, a running runtime at `RUNTIME_ADDRESS` started with
 * `MACP_AUTH_TOKENS_FILE` holding the tokens below, and the runtime binary present. RegisterPolicy
 * needs `can_manage_mode_registry` (crates/macp-auth/src/security.rs:452), so the observer entry is
 * `{"token":"cp-observer-token","sender":"macp-control-plane","is_observer":true,
 * "can_manage_mode_registry":true}`; `agent-alpha-token` → `agent-alpha` needs `can_start_sessions`.
 * It does not restart the runtime. Verified 22/22 against a locally built v0.9.0. Expects a runtime with no vendor rule extensions registered
 * (the stock v0.9.0 binary), so every `x-` key is refused.
 */
const RUNTIME_ADDRESS = process.env.RUNTIME_ADDRESS ?? '127.0.0.1:50051';
const AGENT_ALPHA = { token: 'agent-alpha-token', sender: 'agent-alpha' };
const CP_OBSERVER_TOKEN = 'cp-observer-token';
const DECISION = 'macp.mode.decision.v1';

function loadProtoDir(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { protoDir } = require('@multiagentcoordinationprotocol/proto');
  return protoDir as string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeAgentServiceClient(): any {
  const pkgDef = protoLoader.loadSync(['macp/v1/core.proto', 'macp/v1/envelope.proto'], {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [loadProtoDir()]
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (grpc.loadPackageDefinition(pkgDef) as any).macp.v1.MACPRuntimeService;
}

/** A UUID string with the given version nibble (variant bits RFC 4122), lowercase. */
function uuidWithVersion(version: number): string {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | (version << 4);
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A base64url token of exactly `length` chars. */
function token(length: number): string {
  return randomBytes(length).toString('base64url').slice(0, length);
}

describeWithLocalRuntime('Admission parity with a live macp-runtime (integration)', () => {
  let ctx: TestAppContext;
  let validator: PolicyRulesValidatorService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let provider: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ServiceCtor: any;
  let SessionStartPayload: protobuf.Type;
  const savedEnv: Record<string, string | undefined> = {};
  const registeredPolicies: string[] = [];
  const openedSessions: string[] = [];

  function overrideEnv(name: string, value: string): void {
    savedEnv[name] = process.env[name];
    process.env[name] = value;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function agentCall(method: string, request: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const client = new ServiceCtor(RUNTIME_ADDRESS, grpc.credentials.createInsecure());
      const md = new grpc.Metadata();
      md.set('authorization', `Bearer ${AGENT_ALPHA.token}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client[method](request, md, (err: any, res: any) => {
        client.close();
        if (err) return reject(err);
        resolve(res);
      });
    });
  }

  /** The runtime's verdict on `SessionStart` under `sessionId`: accepted, or the refusal reason. */
  async function runtimeAcceptsSessionId(sessionId: string): Promise<{ accepted: boolean; reason?: string }> {
    const payload = SessionStartPayload.encode(
      SessionStartPayload.create({
        intent: 'admission parity: session id',
        participants: [AGENT_ALPHA.sender],
        modeVersion: '1.0.0',
        configurationVersion: '1.0.0',
        ttlMs: 60000
      })
    ).finish();
    try {
      const res = await agentCall('Send', {
        envelope: {
          macpVersion: '1.0',
          mode: DECISION,
          messageType: 'SessionStart',
          messageId: randomUUID(),
          sessionId,
          sender: AGENT_ALPHA.sender,
          timestampUnixMs: Date.now(),
          payload: Buffer.from(payload)
        }
      });
      if (res?.ack?.ok === true) {
        openedSessions.push(sessionId);
        return { accepted: true };
      }
      return { accepted: false, reason: `${res?.ack?.error?.code}: ${res?.ack?.error?.message}` };
    } catch (err) {
      const code = (err as { code?: number }).code;
      // Transport trouble is not a verdict; fail loudly rather than score it as a refusal.
      if (code === grpc.status.UNAVAILABLE || code === grpc.status.UNAUTHENTICATED) throw err;
      return { accepted: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  beforeAll(async () => {
    overrideEnv('SESSION_DISCOVERY_ENABLED', 'false');
    overrideEnv('RUNTIME_BEARER_TOKEN', CP_OBSERVER_TOKEN);
    ctx = await createTestApp();
    provider = ctx.app.get(RuntimeProviderRegistry).get('rust');
    await provider.initialize({ clientName: 'admission-parity-spec', clientVersion: '0.0.0' });
    validator = ctx.app.get(PolicyRulesValidatorService);
    ServiceCtor = makeAgentServiceClient();
    const protoDir = loadProtoDir();
    const root = new protobuf.Root();
    root.resolvePath = (_origin: string, target: string) => (target.startsWith('/') ? target : `${protoDir}/${target}`);
    await root.load(['macp/v1/core.proto']);
    SessionStartPayload = root.lookupType('macp.v1.SessionStartPayload');
  }, 90000);

  afterAll(async () => {
    for (const sessionId of openedSessions) {
      await agentCall('CancelSession', { sessionId, reason: 'admission parity cleanup' }).catch(() => undefined);
    }
    for (const policyId of registeredPolicies) {
      await provider?.unregisterPolicy({ policyId }).catch(() => undefined);
    }
    if (ctx) await ctx.app.close();
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }, 90000);

  it('advertises the policy registry rule extensions on Initialize (none on a stock runtime)', () => {
    expect(provider.capabilities?.policyRegistry?.ruleExtensions).toEqual([]);
  });

  describe('AC3: policy rule admission', () => {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['a misspelt nested key', DECISION, { objection_handling: { veto_threshhold: 1 } }],
      ['an undefined top-level key', DECISION, { audit: { enabled: true } }],
      ['an unadvertised vendor extension', DECISION, { 'x-com.example': { level: 1 } }],
      ['a non-object vendor extension value', DECISION, { 'x-com.example': 1 }],
      ['a nested vendor extension key', DECISION, { voting: { 'x-com.example.gov': {} } }],
      ['a malformed x- key', DECISION, { 'x-seam': {} }],
      ['an undefined key on a "*" policy', '*', { nope: 1 }],
      [
        'annotation keys at every level',
        DECISION,
        { _note: 'top', voting: { $comment: 'nested', algorithm: 'majority' } }
      ],
      ['an annotation key on a "*" policy', '*', { _note: 'x', voting: { algorithm: 'majority' } }],
      [
        'acceptance children from two modes on a "*" policy',
        '*',
        { acceptance: { criterion: 'all_parties', implicit_accept_timeout_ms: 1000 } }
      ],
      [
        'a mistyped value under a mixed "*" acceptance',
        '*',
        { acceptance: { criterion: 'all_parties', implicit_accept_timeout_ms: 'soon' } }
      ],
      ['a misspelt nested key on a "*" policy', '*', { acceptance: { criterium: 'all_parties' } }],
      ['a well-formed decision policy', DECISION, { voting: { algorithm: 'majority' } }]
    ];

    it.each(cases)('the runtime and the CP agree on %s', async (_label, mode, rules) => {
      const cpErrors = validator.validateRules(mode, rules, {
        ruleExtensions: provider.capabilities?.policyRegistry?.ruleExtensions
      });
      const policyId = `policy.test.parity.${randomUUID()}`;
      const result = await provider.registerPolicy({
        descriptor: {
          policyId,
          mode,
          description: 'admission parity',
          rules: Buffer.from(JSON.stringify(rules)),
          schemaVersion: 3
        }
      });
      if (result.ok) registeredPolicies.push(policyId);

      expect({ runtimeAccepted: result.ok, cpAccepted: cpErrors.length === 0 }).toEqual({
        runtimeAccepted: cpErrors.length === 0,
        cpAccepted: cpErrors.length === 0
      });
      if (!result.ok) {
        expect(result.error).toContain('INVALID_POLICY_DEFINITION');
        // Same path-naming refusal: the CP's message for the first offending key appears in the runtime's.
        const firstKeyPath = cpErrors[0].split(/[ :]/)[0];
        if (firstKeyPath.startsWith('rules.')) expect(result.error).toContain(firstKeyPath);
      }
    });
  });

  describe('AC5: session id admission', () => {
    const candidates: Array<[string, string]> = [
      ['a lowercase UUID v4', uuidWithVersion(4)],
      ['a lowercase UUID v7', uuidWithVersion(7)],
      ['a 22-char base64url token', token(22)],
      ['a 128-byte base64url token', token(128)],
      ['an uppercase UUID v4', uuidWithVersion(4).toUpperCase()],
      ['a UUID v1', uuidWithVersion(1)],
      ['a 129-byte base64url token', token(129)],
      ['a 21-char token', token(21)]
    ];

    it.each(candidates)('the runtime and isValidSessionId agree on %s', async (_label, sessionId) => {
      const verdict = await runtimeAcceptsSessionId(sessionId);
      expect({ sessionId, runtimeAccepted: verdict.accepted, reason: verdict.reason }).toEqual({
        sessionId,
        runtimeAccepted: isValidSessionId(sessionId),
        reason: verdict.reason
      });
    });
  });
});
