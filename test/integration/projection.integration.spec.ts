import { createTestApp, TestAppContext } from '../helpers/test-app';
import { decisionModeRequest, decisionHappyScript } from '../fixtures/decision-mode';
import { waitFor } from '../helpers/wait-for';
import { RunEventService } from '../../src/events/run-event.service';

describe('Projection (integration, observer mode)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp(decisionHappyScript());
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await ctx.cleanup();
  });

  it('projection includes all required sections', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());

    const state = await waitFor(
      async () => {
        const s = (await ctx.client.getState(runId)) as any;
        return s.timeline?.totalEvents >= 1 ? s : null;
      },
      { timeoutMs: 5000, label: 'projection populated' },
    );

    expect(state).toHaveProperty('run');
    expect(state).toHaveProperty('participants');
    expect(state).toHaveProperty('graph');
    expect(state).toHaveProperty('decision');
    expect(state).toHaveProperty('signals');
    expect(state).toHaveProperty('progress');
    expect(state).toHaveProperty('timeline');
    expect(state).toHaveProperty('trace');
    expect(state).toHaveProperty('outboundMessages');
  });

  // #117: concurrent event transactions for one run must not drop each other's
  // projection changes. Each emit carries a distinct participant; all must survive.
  it('concurrent event transactions for one run keep every projection change', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());
    const runEvents = ctx.module.get(RunEventService);
    // Batches stay well under DB_POOL_MAX so this exercises the lost update, not pool exhaustion.
    const ids = Array.from({ length: 24 }, (_, i) => `concurrent-${i}`);

    for (let i = 0; i < ids.length; i += 4) {
      await Promise.all(
        ids.slice(i, i + 4).map((id) =>
          runEvents.emitControlPlaneEvents(runId, [
            {
              ts: new Date().toISOString(),
              type: 'participant.seen',
              source: { kind: 'macp-control-plane', name: 'projection-race-test' },
              subject: { kind: 'participant', id },
              data: { participantId: id, status: 'idle' }
            }
          ])
        )
      );
    }

    const state = (await ctx.client.getState(runId)) as any;
    const projected = (state.participants ?? []).map((p: any) => p.participantId);
    expect(projected).toEqual(expect.arrayContaining(ids));
    expect(state.timeline.latestSeq).toBeGreaterThanOrEqual(ids.length);
  });

  it('projection tracks participant status from scripted events', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());

    const state = await waitFor(
      async () => {
        const s = (await ctx.client.getState(runId)) as any;
        return s.participants?.length > 0 ? s : null;
      },
      { timeoutMs: 5000, label: 'participants populated' },
    );

    expect(state.participants[0]).toHaveProperty('participantId');
    expect(state.participants[0]).toHaveProperty('status');
  });

  it('projection tracks timeline with sequence numbers', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());

    const state = await waitFor(
      async () => {
        const s = (await ctx.client.getState(runId)) as any;
        return s.timeline?.totalEvents > 0 ? s : null;
      },
      { timeoutMs: 5000, label: 'timeline populated' },
    );

    expect(state.timeline.latestSeq).toBeGreaterThan(0);
    expect(state.timeline.totalEvents).toBeGreaterThan(0);
  });

  it('projection graph tracks message flow emitted by agents (via observer stream)', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());

    const state = await waitFor(
      async () => {
        const s = (await ctx.client.getState(runId)) as any;
        return s.graph?.nodes?.length > 0 ? s : null;
      },
      { timeoutMs: 5000, label: 'graph populated' },
    );

    expect(state.graph).toHaveProperty('nodes');
    expect(state.graph).toHaveProperty('edges');
  });

  it('projection rebuilds from canonical events', async () => {
    const { runId } = await ctx.client.createRun(decisionModeRequest());

    await waitFor(
      async () => {
        const run = (await ctx.client.getRun(runId)) as any;
        return ['completed', 'failed', 'cancelled'].includes(run.status) ? run : null;
      },
      { timeoutMs: 5000, label: 'run terminal' },
    );

    const before = (await ctx.client.getState(runId)) as any;
    await ctx.client.rebuildProjection(runId);
    const after = (await ctx.client.getState(runId)) as any;

    expect(after.run.runId).toBe(before.run.runId);
    expect(after.run.status).toBe(before.run.status);
    expect(after.timeline.totalEvents).toBeGreaterThanOrEqual(before.timeline.totalEvents);
  });
});
