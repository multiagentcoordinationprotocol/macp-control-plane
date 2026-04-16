import { createTestApp, TestAppContext } from '../helpers/test-app';
import { decisionHappyScript, decisionModeRequest } from '../fixtures/decision-mode';
import { proposalAcceptScript, proposalModeRequest } from '../fixtures/proposal-mode';
import { taskHappyScript, taskModeRequest } from '../fixtures/task-mode';
import { quorumReachedScript, quorumModeRequest } from '../fixtures/quorum-mode';
import { handoffAcceptScript, handoffModeRequest } from '../fixtures/handoff-mode';
import { waitFor } from '../helpers/wait-for';

/**
 * Observer-mode end-to-end (direct-agent-auth CP-13).
 *
 * These tests verify the control-plane correctly observes and projects the full
 * scripted event stream for each of the 5 canonical modes — without any
 * envelope-emission HTTP endpoints. Agents (simulated here by the mock) drive
 * the session entirely via their own gRPC connection.
 */
describe('Observer mode — end-to-end projection (integration)', () => {
  const cases = [
    {
      name: 'decision',
      request: () => decisionModeRequest(),
      script: () => decisionHappyScript(),
      expectTypes: ['proposal.created', 'proposal.updated', 'decision.finalized'],
    },
    {
      name: 'proposal',
      request: () => proposalModeRequest(),
      script: () => proposalAcceptScript(),
      expectTypes: ['proposal.created', 'proposal.updated', 'decision.finalized'],
    },
    {
      name: 'task',
      request: () => taskModeRequest(),
      script: () => taskHappyScript(),
      expectTypes: ['proposal.created', 'proposal.updated'],
    },
    {
      name: 'quorum',
      request: () => quorumModeRequest(),
      script: () => quorumReachedScript(),
      expectTypes: ['proposal.created', 'proposal.updated', 'decision.finalized'],
    },
    {
      name: 'handoff',
      request: () => handoffModeRequest(),
      script: () => handoffAcceptScript(),
      expectTypes: ['proposal.created', 'proposal.updated'],
    },
  ] as const;

  for (const c of cases) {
    describe(`${c.name} mode`, () => {
      let ctx: TestAppContext;

      beforeAll(async () => {
        ctx = await createTestApp(c.script());
      });

      afterAll(async () => {
        await ctx.app.close();
      });

      beforeEach(async () => {
        await ctx.cleanup();
      });

      it('projects the full scripted event stream without control-plane Send', async () => {
        const { runId, sessionId } = await ctx.client.createRun(c.request());
        expect(sessionId).toMatch(/^[0-9a-f]{8}-/);

        // Poll until every expected event type has arrived via the observer stream.
        const events = await waitFor(
          async () => {
            const raw = await ctx.client.listEvents(runId);
            if (!Array.isArray(raw)) return null;
            const allPresent = c.expectTypes.every((t) => raw.some((ev: any) => ev.type === t));
            return allPresent ? raw : null;
          },
          { timeoutMs: 8000, label: `${c.name} mode events` },
        );

        for (const type of c.expectTypes) {
          expect(events.find((e: any) => e.type === type)).toBeDefined();
        }

        // Invariant: the control-plane never emitted a send-ack (it doesn't call Send).
        // Normalized events from Send acks come out as `message.sent` with subject
        // kind 'message' AND source.kind === 'control-plane'. Observer mode only ever
        // emits 'message.sent' from received runtime envelopes (source.kind === 'runtime').
        const controlPlaneSends = events.filter(
          (e: any) => e.type === 'message.sent' && e.source?.kind === 'control-plane',
        );
        expect(controlPlaneSends).toHaveLength(0);
      });
    });
  }
});
