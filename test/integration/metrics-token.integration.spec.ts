import { createTestApp, TestAppContext } from '../helpers/test-app';
import { decisionHappyScript } from '../fixtures/decision-mode';
import { testRuntimeKind } from '../helpers/runtime-kind';
import { waitFor } from '../helpers/wait-for';

describe('Metrics Token Usage (integration)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp(decisionHappyScript());
  });

  afterAll(async () => {
    if (ctx) await ctx.app.close();
  });

  async function waitForMetrics(runId: string) {
    return waitFor(
      async () => {
        const metrics = (await ctx.client.request('GET', `/runs/${runId}/metrics`)) as any;
        return metrics.runId === runId ? metrics : null;
      },
      { timeoutMs: 5000, label: 'metrics ready' },
    );
  }

  it('GET /runs/:id/metrics returns token usage fields', async () => {
    const run = await ctx.client.createRun({
      mode: 'sandbox',
      runtime: { kind: testRuntimeKind() },
      session: {
        modeName: 'macp.mode.decision.v1',
        modeVersion: '1.0.0',
        configurationVersion: '1.0.0',
        ttlMs: 60000,
        participants: [{ id: 'agent-a' }, { id: 'agent-b' }],
      },
    });

    const metrics = await waitForMetrics(run.runId);

    expect(metrics).toHaveProperty('runId', run.runId);
    expect(metrics).toHaveProperty('eventCount');
    expect(metrics).toHaveProperty('messageCount');
    expect(metrics).toHaveProperty('promptTokens');
    expect(metrics).toHaveProperty('completionTokens');
    expect(metrics).toHaveProperty('totalTokens');
    expect(metrics).toHaveProperty('estimatedCostUsd');
    expect(typeof metrics.promptTokens).toBe('number');
    expect(typeof metrics.completionTokens).toBe('number');
    expect(typeof metrics.totalTokens).toBe('number');
    expect(typeof metrics.estimatedCostUsd).toBe('number');
  });

  it('token fields default to 0 for runs without token data', async () => {
    const run = await ctx.client.createRun({
      mode: 'sandbox',
      runtime: { kind: testRuntimeKind() },
      session: {
        modeName: 'macp.mode.decision.v1',
        modeVersion: '1.0.0',
        configurationVersion: '1.0.0',
        ttlMs: 60000,
        participants: [{ id: 'agent-a' }],
      },
    });

    const metrics = await waitForMetrics(run.runId);

    expect(metrics.promptTokens).toBe(0);
    expect(metrics.completionTokens).toBe(0);
    expect(metrics.totalTokens).toBe(0);
    expect(metrics.estimatedCostUsd).toBe(0);
  });

  it('run state includes metrics-relevant fields after completion', async () => {
    const run = await ctx.client.createRun({
      mode: 'sandbox',
      runtime: { kind: testRuntimeKind() },
      session: {
        modeName: 'macp.mode.decision.v1',
        modeVersion: '1.0.0',
        configurationVersion: '1.0.0',
        ttlMs: 60000,
        participants: [{ id: 'agent-a' }, { id: 'agent-b' }],
      },
    });

    const state = await waitFor(
      async () => {
        const s = (await ctx.client.getState(run.runId)) as any;
        return s.timeline?.totalEvents > 0 ? s : null;
      },
      { timeoutMs: 5000, label: 'state populated' },
    );

    expect(typeof state.timeline.totalEvents).toBe('number');
  });
});
