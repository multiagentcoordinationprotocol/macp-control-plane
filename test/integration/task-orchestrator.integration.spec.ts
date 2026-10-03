import { createTestApp, TestAppContext } from '../helpers/test-app';
import { taskOrchestratorRequest, taskOrchestratorScript } from '../fixtures/task-mode';
import { waitFor } from '../helpers/wait-for';
import { isRealRuntime } from '../helpers/real-runtime-gate';

/**
 * Task mode with an external orchestrator (runtime v0.5.0): the initiator is not in the
 * `participants` pool. The control plane performs no initiator-membership validation, so
 * the run must start, observe the orchestrator's envelopes, and project it as a participant.
 * Mock-only: the live-runtime variant needs agent tokens and is not part of CI.
 */
const describeMock = isRealRuntime ? describe.skip : describe;

describeMock('Task mode — external orchestrator outside the participant pool (integration)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp(taskOrchestratorScript());
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await ctx.cleanup();
    ctx.mockRuntime.setScript(taskOrchestratorScript());
  });

  it('accepts the run and projects the orchestrator alongside the pool participants', async () => {
    const { runId } = await ctx.client.createRun(taskOrchestratorRequest());

    const state = await waitFor(
      async () => {
        const s = (await ctx.client.getState(runId)) as any;
        const ids = (s.participants ?? []).map((p: any) => p.participantId);
        return ids.includes('orchestrator') && ids.includes('worker') ? s : null;
      },
      { timeoutMs: 8000, label: 'orchestrator and worker projected' }
    );

    const ids = state.participants.map((p: any) => p.participantId);
    expect(ids).toEqual(expect.arrayContaining(['orchestrator', 'worker']));

    const run = (await ctx.client.getRun(runId)) as any;
    expect(run.status).not.toBe('failed');
  });
});
