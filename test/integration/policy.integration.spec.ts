import { createTestApp, TestAppContext } from '../helpers/test-app';
import { decisionHappyScript } from '../fixtures/decision-mode';
import { RuntimeProviderRegistry } from '../../src/runtime/runtime-provider.registry';
import { testRuntimeKind } from '../helpers/runtime-kind';
import { waitFor } from '../helpers/wait-for';

const isRealRuntime =
  process.env.INTEGRATION_RUNTIME === 'docker' ||
  process.env.INTEGRATION_RUNTIME === 'remote';

describe('Policy Projection in Run State (integration)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp(isRealRuntime ? undefined : decisionHappyScript());
  });

  afterAll(async () => {
    if (ctx) await ctx.app.close();
  });

  it('run state includes policy projection with empty defaults', async () => {
    const run = await ctx.client.createRun({
      mode: 'sandbox',
      runtime: { kind: testRuntimeKind() },
      session: {
        modeName: 'macp.mode.decision.v1',
        modeVersion: '1.0.0',
        configurationVersion: '1.0.0',
        ttlMs: 60000,
        participants: [{ id: 'agent-a' }],
      }
    });

    const state = await waitFor(
      async () => {
        const s = (await ctx.client.getState(run.runId)) as any;
        return s.policy ? s : null;
      },
      { timeoutMs: 3000, label: 'policy projection populated' },
    );

    expect(state).toHaveProperty('policy');
    expect(state.policy).toHaveProperty('policyVersion');
    expect(state.policy).toHaveProperty('commitmentEvaluations');
    expect(Array.isArray(state.policy.commitmentEvaluations)).toBe(true);
  });
});

// Policy provider methods test the runtime provider API directly.
// In real runtime mode, the gRPC policy API may have different behavior.
const describeProviderMethods = isRealRuntime ? describe.skip : describe;
describeProviderMethods('Policy Provider Methods (integration)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp(isRealRuntime ? undefined : decisionHappyScript());
  });

  afterAll(async () => {
    if (ctx) await ctx.app.close();
  });

  it('ScriptedMockRuntimeProvider supports policy registration round-trip', async () => {
    // Access the runtime provider registry directly via the NestJS module
    const registry = ctx.app.get(RuntimeProviderRegistry);
    const provider = registry.get(testRuntimeKind());

    // Register
    const registerResult = await provider.registerPolicy({
      descriptor: {
        policyId: 'policy.test.majority',
        mode: 'macp.mode.decision.v1',
        description: 'Test majority voting policy',
        rules: Buffer.from(JSON.stringify({
          voting: { algorithm: 'majority', threshold: 0.5, quorum: { type: 'count', value: 2 } },
          objection_handling: { block_severity_vetoes: false, veto_threshold: 1 },
          commitment: { authority: 'initiator_only', require_vote_quorum: true }
        })),
        schemaVersion: 1
      }
    });
    expect(registerResult.ok).toBe(true);

    // Get
    const policy = await provider.getPolicy({ policyId: 'policy.test.majority' });
    expect(policy.policyId).toBe('policy.test.majority');
    expect(policy.mode).toBe('macp.mode.decision.v1');
    expect(policy.description).toBe('Test majority voting policy');

    // List
    const policies = await provider.listPolicies({ mode: 'macp.mode.decision.v1' });
    expect(policies.length).toBeGreaterThanOrEqual(1);
    const found = policies.find(p => p.policyId === 'policy.test.majority');
    expect(found).toBeDefined();

    // List with filter (non-matching mode)
    const empty = await provider.listPolicies({ mode: 'macp.mode.task.v1' });
    const notFound = empty.find(p => p.policyId === 'policy.test.majority');
    expect(notFound).toBeUndefined();

    // Unregister
    const unregResult = await provider.unregisterPolicy({ policyId: 'policy.test.majority' });
    expect(unregResult.ok).toBe(true);

    // Verify gone from list
    const afterDelete = await provider.listPolicies({});
    const stillThere = afterDelete.find(p => p.policyId === 'policy.test.majority');
    expect(stillThere).toBeUndefined();
  });
});

