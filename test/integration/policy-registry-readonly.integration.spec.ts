/**
 * Runtime v0.9.0 (S13): a runtime booted with MACP_POLICIES_DIR rejects
 * RegisterPolicy with a coded `REGISTRY_READ_ONLY` status. Proves, against the
 * real runtime, that the control plane maps it by `macp-error-code` to
 * AppException(REGISTRY_READ_ONLY, 405) — the deliberate 405 divergence from the
 * registry's 409 — and that the HTTP endpoint answers 405.
 *
 * Needs the `runtime-readonly` compose service (docker-compose.test.yml), which
 * `INTEGRATION_RUNTIME=docker` starts alongside the main runtime. In `remote`
 * mode set RUNTIME_READONLY_ADDRESS to a runtime started with MACP_POLICIES_DIR;
 * without it the spec is skipped, not failed.
 */
import { AppException } from '../../src/errors/app-exception';
import { ErrorCode } from '../../src/errors/error-codes';
import { RuntimeProviderRegistry } from '../../src/runtime/runtime-provider.registry';
import { createTestApp, TestAppContext } from '../helpers/test-app';

const runtimeMode = (process.env.INTEGRATION_RUNTIME ?? 'mock').toLowerCase();
const readOnlyAddress =
  process.env.RUNTIME_READONLY_ADDRESS ?? (runtimeMode === 'docker' ? '127.0.0.1:50052' : undefined);
const describeReadOnly = runtimeMode !== 'mock' && readOnlyAddress ? describe : describe.skip;

describeReadOnly('Policy registry read-only (real runtime, MACP_POLICIES_DIR)', () => {
  let ctx: TestAppContext;
  let previousAddress: string | undefined;

  const policy = {
    policyId: 'policy.test.readonly-probe',
    mode: 'macp.mode.decision.v1',
    description: 'must be refused by a file-loaded registry',
    rules: { voting: { algorithm: 'majority' } },
    schemaVersion: 1
  };

  beforeAll(async () => {
    previousAddress = process.env.RUNTIME_ADDRESS;
    process.env.RUNTIME_ADDRESS = readOnlyAddress;
    ctx = await createTestApp();
  });

  afterAll(async () => {
    if (ctx) await ctx.app.close();
    if (previousAddress === undefined) delete process.env.RUNTIME_ADDRESS;
    else process.env.RUNTIME_ADDRESS = previousAddress;
  });

  it('the provider maps the coded RegisterPolicy refusal to REGISTRY_READ_ONLY 405', async () => {
    const provider = ctx.module.get(RuntimeProviderRegistry).get('rust');

    const thrown = await provider
      .registerPolicy({
        descriptor: {
          policyId: policy.policyId,
          mode: policy.mode,
          description: policy.description,
          rules: JSON.stringify(policy.rules),
          schemaVersion: policy.schemaVersion
        }
      })
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(AppException);
    const err = thrown as AppException;
    expect(err.errorCode).toBe(ErrorCode.REGISTRY_READ_ONLY);
    expect(err.getStatus()).toBe(405);
    expect(err.metadata).toMatchObject({ macpErrorCode: 'REGISTRY_READ_ONLY', grpcCode: 9 });
  });

  it('POST /runtime/policies answers 405 REGISTRY_READ_ONLY', async () => {
    const res = await fetch(`${ctx.url}/runtime/policies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key-integration' },
      body: JSON.stringify(policy)
    });
    const body = (await res.json()) as { errorCode?: string };

    expect(res.status).toBe(405);
    expect(body.errorCode).toBe('REGISTRY_READ_ONLY');
  });

  it('the file-loaded policy is still listed (read path unaffected)', async () => {
    const res = await fetch(`${ctx.url}/runtime/policies`, {
      headers: { Authorization: 'Bearer test-key-integration' }
    });
    const policies = (await res.json()) as Array<{ policyId: string }>;

    expect(res.status).toBe(200);
    expect(policies.map((p) => p.policyId)).toContain('policy.test.file-loaded');
  });
});
