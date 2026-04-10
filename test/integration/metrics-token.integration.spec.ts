import { createTestApp, TestAppContext } from '../helpers/test-app';
import { decisionHappyScript } from '../fixtures/decision-mode';

describe('Metrics Token Usage (integration)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp(decisionHappyScript());
  });

  afterAll(async () => {
    if (ctx) await ctx.app.close();
  });

  it('GET /runs/:id/metrics returns token usage fields', async () => {
    const run = await ctx.client.createRun({
      mode: 'sandbox',
      runtime: { kind: 'scripted-mock' },
      session: {
        modeName: 'macp.mode.decision.v1',
        modeVersion: '1.0.0',
        configurationVersion: '1.0.0',
        ttlMs: 60000,
        participants: [
          { id: 'agent-a', role: 'proposer' },
          { id: 'agent-b', role: 'evaluator' }
        ]
      }
    });

    await sleep(1500);

    const metrics = await ctx.client.request('GET', `/runs/${run.runId}/metrics`) as any;

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
      runtime: { kind: 'scripted-mock' },
      session: {
        modeName: 'macp.mode.decision.v1',
        modeVersion: '1.0.0',
        configurationVersion: '1.0.0',
        ttlMs: 60000,
        participants: [{ id: 'agent-a', role: 'proposer' }]
      }
    });

    await sleep(1500);

    const metrics = await ctx.client.request('GET', `/runs/${run.runId}/metrics`) as any;

    expect(metrics.promptTokens).toBe(0);
    expect(metrics.completionTokens).toBe(0);
    expect(metrics.totalTokens).toBe(0);
    expect(metrics.estimatedCostUsd).toBe(0);
  });

  it('run state includes metrics-relevant fields after completion', async () => {
    const run = await ctx.client.createRun({
      mode: 'sandbox',
      runtime: { kind: 'scripted-mock' },
      session: {
        modeName: 'macp.mode.decision.v1',
        modeVersion: '1.0.0',
        configurationVersion: '1.0.0',
        ttlMs: 60000,
        participants: [
          { id: 'agent-a', role: 'proposer' },
          { id: 'agent-b', role: 'evaluator' }
        ]
      }
    });

    await sleep(1500);

    const state = await ctx.client.getState(run.runId) as any;

    expect(state).toHaveProperty('timeline');
    expect(state.timeline).toHaveProperty('totalEvents');
    expect(typeof state.timeline.totalEvents).toBe('number');
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
