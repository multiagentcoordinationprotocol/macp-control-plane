import { ProjectionService } from './projection.service';
import { ProjectionRepository } from '../storage/projection.repository';
import { CanonicalEvent, RunStateProjection } from '../contracts/control-plane';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<CanonicalEvent> & { type: string }): CanonicalEvent {
  return {
    id: overrides.id ?? 'evt-1',
    runId: overrides.runId ?? 'run-1',
    seq: overrides.seq ?? 1,
    ts: overrides.ts ?? '2026-01-01T00:00:00Z',
    type: overrides.type,
    subject: overrides.subject,
    source: overrides.source ?? { kind: 'runtime', name: 'rust-runtime' },
    trace: overrides.trace,
    data: overrides.data ?? {}
  };
}

// ---------------------------------------------------------------------------
// mock repository
// ---------------------------------------------------------------------------

const mockProjectionRepository: jest.Mocked<ProjectionRepository> = {
  get: jest.fn(),
  upsert: jest.fn()
} as unknown as jest.Mocked<ProjectionRepository>;

// ---------------------------------------------------------------------------
// suite
// ---------------------------------------------------------------------------

describe('ProjectionService', () => {
  let service: ProjectionService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ProjectionService(mockProjectionRepository);
  });

  // -----------------------------------------------------------------------
  // empty()
  // -----------------------------------------------------------------------

  describe('empty()', () => {
    it('returns correct initial state', () => {
      const projection = service.empty('run-1');

      expect(projection).toEqual<RunStateProjection>({
        run: { runId: 'run-1', status: 'queued' },
        participants: [],
        graph: { nodes: [], edges: [] },
        decision: {},
        signals: { signals: [] },
        progress: { entries: [] },
        timeline: { latestSeq: 0, totalEvents: 0, recent: [] },
        trace: { spanCount: 0, linkedArtifacts: [] },
        outboundMessages: { total: 0, queued: 0, accepted: 0, rejected: 0 },
        policy: { policyVersion: '', commitmentEvaluations: [] },
        llm: {
          calls: [],
          totals: { callCount: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0 }
        }
      });
    });
  });

  // -----------------------------------------------------------------------
  // applyEvents — run lifecycle
  // -----------------------------------------------------------------------

  describe('applyEvents — run lifecycle', () => {
    it('run.created updates run summary', () => {
      const base = service.empty('run-1');
      const event = makeEvent({
        type: 'run.created',
        data: {
          status: 'starting',
          modeName: 'decision',
          traceId: 'trace-abc'
        }
      });

      const result = service.applyEvents(base, [event]);

      expect(result.run.status).toBe('starting');
      expect(result.run.modeName).toBe('decision');
      expect(result.run.traceId).toBe('trace-abc');
      expect(result.run.runId).toBe('run-1');
    });

    it('run.completed sets status to completed', () => {
      const base = service.empty('run-1');
      const event = makeEvent({
        type: 'run.completed',
        data: { status: 'completed', endedAt: '2026-01-01T01:00:00Z' }
      });

      const result = service.applyEvents(base, [event]);

      expect(result.run.status).toBe('completed');
      expect(result.run.endedAt).toBe('2026-01-01T01:00:00Z');
    });
  });

  // -----------------------------------------------------------------------
  // applyEvents — participants
  // -----------------------------------------------------------------------

  describe('applyEvents — participants', () => {
    it('participant.seen adds participant and graph node', () => {
      const base = service.empty('run-1');
      const event = makeEvent({
        type: 'participant.seen',
        data: { participantId: 'agent-A' }
      });

      const result = service.applyEvents(base, [event]);

      expect(result.participants).toHaveLength(1);
      expect(result.participants[0]).toEqual({ participantId: 'agent-A', status: 'idle' });
      expect(result.graph.nodes).toHaveLength(1);
      expect(result.graph.nodes[0]).toEqual({ id: 'agent-A', kind: 'participant', status: 'idle' });
    });

    it('participant.seen is idempotent (no duplicate)', () => {
      const base = service.empty('run-1');
      const event1 = makeEvent({
        type: 'participant.seen',
        seq: 1,
        data: { participantId: 'agent-A' }
      });
      const event2 = makeEvent({
        type: 'participant.seen',
        id: 'evt-2',
        seq: 2,
        data: { participantId: 'agent-A' }
      });

      const result = service.applyEvents(base, [event1, event2]);

      expect(result.participants).toHaveLength(1);
      expect(result.graph.nodes).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // applyEvents — messages
  // -----------------------------------------------------------------------

  describe('applyEvents — messages', () => {
    it('message.sent touches sender as active, recipients as waiting, adds edges', () => {
      const base = service.empty('run-1');
      const event = makeEvent({
        type: 'message.sent',
        data: {
          sender: 'agent-A',
          to: ['agent-B', 'agent-C'],
          messageType: 'proposal'
        }
      });

      const result = service.applyEvents(base, [event]);

      // sender should be active
      const sender = result.participants.find((p) => p.participantId === 'agent-A');
      expect(sender).toBeDefined();
      expect(sender!.status).toBe('active');
      expect(sender!.latestSummary).toBe('proposal');

      // recipients should be waiting
      const recipientB = result.participants.find((p) => p.participantId === 'agent-B');
      expect(recipientB).toBeDefined();
      expect(recipientB!.status).toBe('waiting');

      const recipientC = result.participants.find((p) => p.participantId === 'agent-C');
      expect(recipientC).toBeDefined();
      expect(recipientC!.status).toBe('waiting');

      // edges
      expect(result.graph.edges).toHaveLength(2);
      expect(result.graph.edges[0]).toEqual({
        from: 'agent-A',
        to: 'agent-B',
        kind: 'message.sent',
        ts: '2026-01-01T00:00:00Z'
      });
      expect(result.graph.edges[1]).toEqual({
        from: 'agent-A',
        to: 'agent-C',
        kind: 'message.sent',
        ts: '2026-01-01T00:00:00Z'
      });
    });

    it('graph edges are pruned to 200', () => {
      const base = service.empty('run-1');
      // Pre-populate with 199 edges
      for (let i = 0; i < 199; i++) {
        base.graph.edges.push({
          from: `sender-${i}`,
          to: `recipient-${i}`,
          kind: 'message.sent',
          ts: '2026-01-01T00:00:00Z'
        });
      }

      // This event adds 3 edges (sender -> 3 recipients), bringing total to 202
      const event = makeEvent({
        type: 'message.sent',
        data: {
          sender: 'agent-X',
          to: ['agent-Y', 'agent-Z', 'agent-W'],
          messageType: 'notify'
        }
      });

      const result = service.applyEvents(base, [event]);

      expect(result.graph.edges).toHaveLength(200);
      // oldest edges should have been pruned — last edge should be the newest
      expect(result.graph.edges[result.graph.edges.length - 1]).toEqual({
        from: 'agent-X',
        to: 'agent-W',
        kind: 'message.sent',
        ts: '2026-01-01T00:00:00Z'
      });
    });
  });

  // -----------------------------------------------------------------------
  // applyEvents — signals
  // -----------------------------------------------------------------------

  describe('applyEvents — signals', () => {
    it('signal.emitted adds signal', () => {
      const base = service.empty('run-1');
      const event = makeEvent({
        type: 'signal.emitted',
        subject: { kind: 'signal', id: 'sig-1' },
        data: {
          sender: 'agent-A',
          decodedPayload: { signalType: 'anomaly', severity: 'high', confidence: 0.95 }
        }
      });

      const result = service.applyEvents(base, [event]);

      expect(result.signals.signals).toHaveLength(1);
      expect(result.signals.signals[0]).toEqual({
        id: 'sig-1',
        name: 'anomaly',
        severity: 'high',
        sourceParticipantId: 'agent-A',
        ts: '2026-01-01T00:00:00Z',
        confidence: 0.95,
        payload: { signalType: 'anomaly', severity: 'high', confidence: 0.95 }
      });
    });

    it('signal.emitted preserves decoded payload on signal entry (§1.2)', () => {
      const base = service.empty('run-1');
      const event = makeEvent({
        type: 'signal.emitted',
        subject: { kind: 'signal', id: 'sig-42' },
        data: {
          sender: 'agent-A',
          decodedPayload: { signalType: 'anomaly', severity: 'high', detail: { score: 0.97 } }
        }
      });

      const result = service.applyEvents(base, [event]);

      expect(result.signals.signals).toHaveLength(1);
      expect(result.signals.signals[0].payload).toEqual({
        signalType: 'anomaly',
        severity: 'high',
        detail: { score: 0.97 }
      });
    });

    it('signal.acknowledged annotates existing signal with ack timestamp + acknowledger (§1.2)', () => {
      const base = service.empty('run-1');

      const emitted = makeEvent({
        type: 'signal.emitted',
        seq: 1,
        ts: '2026-01-01T00:00:01Z',
        subject: { kind: 'signal', id: 'sig-1' },
        data: {
          sender: 'agent-A',
          decodedPayload: { signalType: 'anomaly' }
        }
      });
      const ack = makeEvent({
        type: 'signal.acknowledged',
        id: 'evt-ack',
        seq: 2,
        ts: '2026-01-01T00:00:02Z',
        subject: { kind: 'signal', id: 'sig-1' },
        data: {
          sender: 'agent-B',
          decodedPayload: { signalId: 'sig-1' }
        }
      });

      const result = service.applyEvents(base, [emitted, ack]);

      expect(result.signals.signals).toHaveLength(1);
      expect(result.signals.signals[0].acknowledgedAt).toBe('2026-01-01T00:00:02Z');
      expect(result.signals.signals[0].acknowledgedBy).toBe('agent-B');
    });

    it('signal.acknowledged without matching signal is a no-op (§1.2)', () => {
      const base = service.empty('run-1');
      const ack = makeEvent({
        type: 'signal.acknowledged',
        subject: { kind: 'signal', id: 'sig-missing' },
        data: { sender: 'agent-B', decodedPayload: { signalId: 'sig-missing' } }
      });

      const result = service.applyEvents(base, [ack]);

      expect(result.signals.signals).toHaveLength(0);
    });

    it('signals are pruned to 200', () => {
      const base = service.empty('run-1');
      // Pre-populate with 200 signals
      for (let i = 0; i < 200; i++) {
        base.signals.signals.push({
          id: `sig-${i}`,
          name: 'old',
          ts: '2026-01-01T00:00:00Z'
        });
      }

      const event = makeEvent({
        type: 'signal.emitted',
        subject: { kind: 'signal', id: 'sig-new' },
        data: {
          decodedPayload: { signalType: 'new-signal' }
        }
      });

      const result = service.applyEvents(base, [event]);

      expect(result.signals.signals).toHaveLength(200);
      expect(result.signals.signals[result.signals.signals.length - 1].id).toBe('sig-new');
      // oldest signal should be pruned
      expect(result.signals.signals[0].id).toBe('sig-1');
    });
  });

  // -----------------------------------------------------------------------
  // applyEvents — decisions
  // -----------------------------------------------------------------------

  describe('applyEvents — decisions', () => {
    it('proposal.created sets decision.current', () => {
      const base = service.empty('run-1');
      const event = makeEvent({
        type: 'proposal.created',
        subject: { kind: 'proposal', id: 'prop-1' },
        data: {
          decodedPayload: {
            proposalId: 'prop-1',
            confidence: 0.8,
            reason: 'Analysis complete'
          }
        }
      });

      const result = service.applyEvents(base, [event]);

      expect(result.decision.current).toBeDefined();
      expect(result.decision.current!.action).toBe('prop-1');
      expect(result.decision.current!.confidence).toBe(0.8);
      expect(result.decision.current!.reasons).toEqual(['Analysis complete']);
      expect(result.decision.current!.finalized).toBe(false);
      expect(result.decision.current!.proposalId).toBe('prop-1');
    });

    it('keeps the decision finalized when a Proposal/Vote arrives or replays AFTER decision.finalized', () => {
      // Regression: with two-phase deliberation + stream reconnects, a
      // proposal.updated (e.g. a late/replayed Vote) can be applied after the
      // decision.finalized that committed the run. It must NOT un-finalize the
      // decision or relabel the committed action — otherwise a completed run
      // renders as `finalized: false` with the action stuck on a proposal id.
      const base = service.empty('run-1');
      const finalize = makeEvent({
        seq: 10,
        type: 'decision.finalized',
        subject: { kind: 'decision', id: 'dec-1' },
        data: { decodedPayload: { action: 'decline', outcome_positive: false, commitmentId: 'prop-1-final' } }
      });
      const lateVote = makeEvent({
        seq: 11,
        type: 'proposal.updated',
        subject: { kind: 'proposal', id: 'prop-1' },
        data: { messageType: 'Vote', sender: 'growth-agent', decodedPayload: { proposalId: 'prop-1', vote: 'APPROVE' } }
      });

      const result = service.applyEvents(base, [finalize, lateVote]);

      expect(result.decision.current!.finalized).toBe(true);
      expect(result.decision.current!.action).toBe('decline');
      expect(result.decision.current!.outcomePositive).toBe(false);
      // the late contribution is still recorded for the per-contributor table
      expect(result.decision.current!.proposals?.some((p) => p.participantId === 'growth-agent')).toBe(true);
    });

    it('decision.finalized with explicit outcome_positive honors the boolean (§1.3)', () => {
      const base = service.empty('run-1');
      const event = makeEvent({
        type: 'decision.finalized',
        subject: { kind: 'decision', id: 'dec-1' },
        data: {
          decodedPayload: {
            action: 'step_up',
            outcome_positive: false,
            commitmentId: 'commit-1'
          }
        }
      });

      const result = service.applyEvents(base, [event]);

      expect(result.decision.current!.outcomePositive).toBe(false);
      expect(result.policy.outcomePositive).toBe(false);
    });

    it('decision.finalized surfaces cross-session supersedes (macp-proto 0.1.3)', () => {
      const base = service.empty('run-1');
      const event = makeEvent({
        type: 'decision.finalized',
        subject: { kind: 'decision', id: 'dec-1' },
        data: {
          decodedPayload: {
            action: 'approve',
            commitmentId: 'commit-2',
            supersedes: { sessionId: 'prior-session', commitmentHash: 'sha256:abc' }
          }
        }
      });

      const result = service.applyEvents(base, [event]);

      expect(result.decision.current!.supersedes).toEqual({
        sessionId: 'prior-session',
        commitmentHash: 'sha256:abc'
      });
    });

    it('decision.finalized omits supersedes when absent', () => {
      const base = service.empty('run-1');
      const event = makeEvent({
        type: 'decision.finalized',
        subject: { kind: 'decision', id: 'dec-1' },
        data: { decodedPayload: { action: 'approve', commitmentId: 'commit-1' } }
      });

      const result = service.applyEvents(base, [event]);

      expect(result.decision.current!.supersedes).toBeUndefined();
    });

    it('decision.finalized infers true from approve-like actions (§1.3)', () => {
      const base = service.empty('run-1');
      const event = makeEvent({
        type: 'decision.finalized',
        subject: { kind: 'decision', id: 'dec-1' },
        data: {
          decodedPayload: { action: 'approve', commitmentId: 'commit-1' }
        }
      });

      const result = service.applyEvents(base, [event]);

      expect(result.decision.current!.outcomePositive).toBe(true);
      expect(result.policy.outcomePositive).toBe(true);
    });

    it('decision.finalized infers false from reject-like actions (§1.3)', () => {
      const base = service.empty('run-1');
      const event = makeEvent({
        type: 'decision.finalized',
        subject: { kind: 'decision', id: 'dec-1' },
        data: {
          decodedPayload: { action: 'declined', commitmentId: 'commit-1' }
        }
      });

      const result = service.applyEvents(base, [event]);

      expect(result.decision.current!.outcomePositive).toBe(false);
      expect(result.policy.outcomePositive).toBe(false);
    });

    it('decision.finalized with unknown action and no explicit outcome uses null (not true) (§1.3)', () => {
      const base = service.empty('run-1');
      const event = makeEvent({
        type: 'decision.finalized',
        subject: { kind: 'decision', id: 'dec-1' },
        data: {
          decodedPayload: { action: 'step_up', commitmentId: 'commit-1' }
        }
      });

      const result = service.applyEvents(base, [event]);

      expect(result.decision.current!.outcomePositive).toBeNull();
      expect(result.policy.outcomePositive).toBeNull();
    });

    it('run.created with decisionPrompt seeds decision.current.prompt (§2.3)', () => {
      const base = service.empty('run-1');
      const event = makeEvent({
        type: 'run.created',
        data: { status: 'starting', decisionPrompt: 'Decide whether to approve the transaction' }
      });

      const result = service.applyEvents(base, [event]);

      expect(result.decision.current?.prompt).toBe('Decide whether to approve the transaction');
    });

    it('proposal.updated accumulates proposals[] contributor breakdown (§2.1)', () => {
      const base = service.empty('run-1');
      const events: CanonicalEvent[] = [
        makeEvent({
          type: 'proposal.created',
          seq: 1,
          ts: '2026-01-01T00:00:01Z',
          data: {
            sender: 'proposer',
            messageType: 'Proposal',
            decodedPayload: { proposalId: 'prop-1', option: 'Deploy feature X', rationale: 'ready to ship' }
          }
        }),
        makeEvent({
          type: 'proposal.updated',
          id: 'evt-2',
          seq: 2,
          ts: '2026-01-01T00:00:02Z',
          data: {
            sender: 'evaluator',
            messageType: 'Evaluation',
            decodedPayload: { proposalId: 'prop-1', recommendation: 'APPROVE', confidence: 0.9, reason: 'looks good' }
          }
        }),
        makeEvent({
          type: 'proposal.updated',
          id: 'evt-3',
          seq: 3,
          ts: '2026-01-01T00:00:03Z',
          data: {
            sender: 'voter',
            messageType: 'Vote',
            decodedPayload: { proposalId: 'prop-1', vote: 'APPROVE', reason: 'approved' }
          }
        })
      ];

      const result = service.applyEvents(base, events);

      expect(result.decision.current?.proposals).toHaveLength(3);
      expect(result.decision.current?.proposals?.[0]).toMatchObject({
        participantId: 'proposer',
        action: 'Deploy feature X',
        reasons: ['ready to ship'],
        messageType: 'Proposal'
      });
      expect(result.decision.current?.proposals?.[1]).toMatchObject({
        participantId: 'evaluator',
        action: 'APPROVE',
        vote: 'allow',
        confidence: 0.9,
        messageType: 'Evaluation'
      });
      expect(result.decision.current?.proposals?.[2]).toMatchObject({
        participantId: 'voter',
        action: 'APPROVE',
        vote: 'allow',
        messageType: 'Vote'
      });
    });

    it('decision.finalized sets resolvedAt + resolvedBy (§2.2)', () => {
      const base = service.empty('run-1');
      const event = makeEvent({
        type: 'decision.finalized',
        ts: '2026-01-01T00:00:10Z',
        subject: { kind: 'decision', id: 'dec-1' },
        data: {
          sender: 'system',
          decodedPayload: { action: 'approve', commitmentId: 'commit-1' }
        }
      });

      const result = service.applyEvents(base, [event]);

      expect(result.decision.current?.resolvedAt).toBe('2026-01-01T00:00:10Z');
      expect(result.decision.current?.resolvedBy).toBe('system');
    });

    it('decision.finalized marks finalized and sets run completed', () => {
      const base = service.empty('run-1');
      base.run.status = 'running';

      const event = makeEvent({
        type: 'decision.finalized',
        subject: { kind: 'decision', id: 'dec-1' },
        data: {
          decodedPayload: {
            action: 'approve',
            confidence: 1.0,
            reason: 'Consensus reached',
            commitmentId: 'commit-1'
          }
        }
      });

      const result = service.applyEvents(base, [event]);

      expect(result.decision.current).toBeDefined();
      expect(result.decision.current!.finalized).toBe(true);
      expect(result.decision.current!.action).toBe('approve');
      expect(result.decision.current!.confidence).toBe(1.0);
      expect(result.decision.current!.reasons).toEqual(['Consensus reached']);
      expect(result.decision.current!.proposalId).toBe('commit-1');
      expect(result.run.status).toBe('completed');
    });
  });

  // -----------------------------------------------------------------------
  // applyEvents — artifacts
  // -----------------------------------------------------------------------

  describe('applyEvents — artifacts', () => {
    it('artifact.created adds to linkedArtifacts', () => {
      const base = service.empty('run-1');
      const event1 = makeEvent({
        type: 'artifact.created',
        seq: 1,
        subject: { kind: 'artifact', id: 'art-1' },
        data: {}
      });
      const event2 = makeEvent({
        type: 'artifact.created',
        id: 'evt-2',
        seq: 2,
        subject: { kind: 'artifact', id: 'art-2' },
        data: {}
      });

      const result = service.applyEvents(base, [event1, event2]);

      expect(result.trace.linkedArtifacts).toEqual(['art-1', 'art-2']);
    });
  });

  // -----------------------------------------------------------------------
  // applyEvents — timeline
  // -----------------------------------------------------------------------

  describe('applyEvents — timeline', () => {
    it('tracks recent events (max 50) and totalEvents', () => {
      const base = service.empty('run-1');
      const events: CanonicalEvent[] = [];

      for (let i = 1; i <= 60; i++) {
        events.push(
          makeEvent({
            id: `evt-${i}`,
            seq: i,
            type: 'message.sent',
            data: { sender: 'a', to: ['b'] }
          })
        );
      }

      const result = service.applyEvents(base, events);

      expect(result.timeline.totalEvents).toBe(60);
      expect(result.timeline.latestSeq).toBe(60);
      expect(result.timeline.recent).toHaveLength(50);
      // recent should contain the last 50 events (seq 11..60)
      expect(result.timeline.recent[0].seq).toBe(11);
      expect(result.timeline.recent[49].seq).toBe(60);
    });
  });

  // -----------------------------------------------------------------------
  // applyEvents — session state
  // -----------------------------------------------------------------------

  describe('applyEvents — session state', () => {
    it('session.state.changed SESSION_STATE_RESOLVED sets run completed', () => {
      const base = service.empty('run-1');
      base.run.status = 'running';

      const event = makeEvent({
        type: 'session.state.changed',
        data: { sessionId: 'session-1', state: 'SESSION_STATE_RESOLVED' }
      });

      const result = service.applyEvents(base, [event]);

      expect(result.run.status).toBe('completed');
      expect(result.run.runtimeSessionId).toBe('session-1');
    });
  });

  // -----------------------------------------------------------------------
  // applyEvents — terminal participant sweep (§1.1)
  // -----------------------------------------------------------------------

  describe('applyEvents — terminal participant sweep', () => {
    function seed(
      base: RunStateProjection,
      id: string,
      status: 'idle' | 'active' | 'waiting',
      latestActivityAt?: string
    ) {
      base.participants.push({ participantId: id, status, latestActivityAt });
      base.graph.nodes.push({ id, kind: 'participant', status });
    }

    it('run.completed promotes participants with activity to completed, idle ones to skipped', () => {
      const base = service.empty('run-1');
      base.run.status = 'running';
      seed(base, 'agent-A', 'active', '2026-01-01T00:00:05Z');
      seed(base, 'agent-B', 'waiting', '2026-01-01T00:00:03Z');
      seed(base, 'agent-C', 'idle');

      const result = service.applyEvents(base, [makeEvent({ type: 'run.completed', data: { status: 'completed' } })]);

      const byId = (id: string) => result.participants.find((p) => p.participantId === id)!;
      expect(byId('agent-A').status).toBe('completed');
      expect(byId('agent-B').status).toBe('completed');
      expect(byId('agent-C').status).toBe('skipped');

      const nodeById = (id: string) => result.graph.nodes.find((n) => n.id === id)!;
      expect(nodeById('agent-A').status).toBe('completed');
      expect(nodeById('agent-B').status).toBe('completed');
      expect(nodeById('agent-C').status).toBe('skipped');
    });

    it('run.failed marks last-active participant as failed, others completed/skipped', () => {
      const base = service.empty('run-1');
      base.run.status = 'running';
      seed(base, 'agent-A', 'active', '2026-01-01T00:00:01Z');
      seed(base, 'agent-B', 'active', '2026-01-01T00:00:10Z');
      seed(base, 'agent-C', 'idle');

      const result = service.applyEvents(base, [
        makeEvent({ type: 'run.failed', data: { status: 'failed', error: 'boom' } })
      ]);

      const byId = (id: string) => result.participants.find((p) => p.participantId === id)!;
      expect(byId('agent-A').status).toBe('completed');
      expect(byId('agent-B').status).toBe('failed');
      expect(byId('agent-C').status).toBe('skipped');
    });

    it('run.cancelled sweeps like completed (never failed)', () => {
      const base = service.empty('run-1');
      base.run.status = 'running';
      seed(base, 'agent-A', 'active', '2026-01-01T00:00:05Z');
      seed(base, 'agent-B', 'idle');

      const result = service.applyEvents(base, [makeEvent({ type: 'run.cancelled', data: { status: 'cancelled' } })]);

      const byId = (id: string) => result.participants.find((p) => p.participantId === id)!;
      expect(byId('agent-A').status).toBe('completed');
      expect(byId('agent-B').status).toBe('skipped');
    });

    it('does not overwrite already-terminal participants', () => {
      const base = service.empty('run-1');
      base.run.status = 'running';
      base.participants.push({ participantId: 'agent-A', status: 'failed', latestActivityAt: '2026-01-01T00:00:01Z' });
      base.graph.nodes.push({ id: 'agent-A', kind: 'participant', status: 'failed' });
      seed(base, 'agent-B', 'active', '2026-01-01T00:00:05Z');

      const result = service.applyEvents(base, [makeEvent({ type: 'run.completed', data: { status: 'completed' } })]);

      expect(result.participants.find((p) => p.participantId === 'agent-A')!.status).toBe('failed');
      expect(result.participants.find((p) => p.participantId === 'agent-B')!.status).toBe('completed');
    });

    it('SESSION_STATE_RESOLVED sweeps participants (skipped for no activity)', () => {
      const base = service.empty('run-1');
      base.run.status = 'running';
      seed(base, 'agent-A', 'active', '2026-01-01T00:00:05Z');
      seed(base, 'agent-B', 'idle');

      const result = service.applyEvents(base, [
        makeEvent({
          type: 'session.state.changed',
          data: { sessionId: 'session-1', state: 'SESSION_STATE_RESOLVED' }
        })
      ]);

      expect(result.participants.find((p) => p.participantId === 'agent-A')!.status).toBe('completed');
      expect(result.participants.find((p) => p.participantId === 'agent-B')!.status).toBe('skipped');
    });

    it('SESSION_STATE_EXPIRED sweeps like failed', () => {
      const base = service.empty('run-1');
      base.run.status = 'running';
      seed(base, 'agent-A', 'active', '2026-01-01T00:00:05Z');
      seed(base, 'agent-B', 'idle');

      const result = service.applyEvents(base, [
        makeEvent({
          type: 'session.state.changed',
          data: { sessionId: 'session-1', state: 'SESSION_STATE_EXPIRED' }
        })
      ]);

      expect(result.participants.find((p) => p.participantId === 'agent-A')!.status).toBe('failed');
      expect(result.participants.find((p) => p.participantId === 'agent-B')!.status).toBe('skipped');
    });
  });

  // -----------------------------------------------------------------------
  // structuredClone fallback
  // -----------------------------------------------------------------------

  describe('structuredClone fallback', () => {
    it('falls back to JSON round-trip when structuredClone fails', () => {
      const originalClone = global.structuredClone;
      // Force structuredClone to throw
      global.structuredClone = () => {
        throw new Error('not available');
      };

      try {
        const base = service.empty('run-1');
        const event = makeEvent({
          type: 'run.created',
          data: { status: 'starting' }
        });

        const result = service.applyEvents(base, [event]);

        expect(result.run.status).toBe('starting');
        // Ensure the original was not mutated
        expect(base.run.status).toBe('queued');
      } finally {
        global.structuredClone = originalClone;
      }
    });
  });

  // -----------------------------------------------------------------------
  // applyAndPersist
  // -----------------------------------------------------------------------

  describe('applyAndPersist()', () => {
    it('loads current projection, applies events, and persists', async () => {
      mockProjectionRepository.get.mockResolvedValue(null as any);
      mockProjectionRepository.upsert.mockResolvedValue(undefined);

      const event = makeEvent({
        type: 'run.created',
        seq: 1,
        data: { status: 'starting' }
      });

      const result = await service.applyAndPersist('run-1', [event]);

      expect(mockProjectionRepository.get).toHaveBeenCalledWith('run-1');
      expect(mockProjectionRepository.upsert).toHaveBeenCalledWith('run-1', expect.any(Object), 1, 3, undefined);
      expect(result.run.status).toBe('starting');
    });
  });

  // -----------------------------------------------------------------------
  // replayStateAt
  // -----------------------------------------------------------------------

  describe('replayStateAt()', () => {
    it('applies events starting from empty state', async () => {
      const events: CanonicalEvent[] = [
        makeEvent({ type: 'run.created', seq: 1, data: { status: 'starting' } }),
        makeEvent({
          type: 'participant.seen',
          id: 'evt-2',
          seq: 2,
          data: { participantId: 'agent-A' }
        })
      ];

      const result = await service.replayStateAt('run-1', events);

      expect(result.run.status).toBe('starting');
      expect(result.participants).toHaveLength(1);
      expect(result.timeline.totalEvents).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // trace tracking
  // -----------------------------------------------------------------------

  describe('trace tracking', () => {
    it('populates traceId, lastSpanId, and spanCount from event trace', () => {
      const base = service.empty('run-1');
      const event = makeEvent({
        type: 'message.sent',
        data: { sender: 'a', to: ['b'] },
        trace: { traceId: 'trace-1', spanId: 'span-1' }
      });

      const result = service.applyEvents(base, [event]);

      expect(result.trace.traceId).toBe('trace-1');
      expect(result.trace.lastSpanId).toBe('span-1');
      expect(result.trace.spanCount).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // policy projection
  // -----------------------------------------------------------------------

  describe('applyEvents — policy', () => {
    it('policy.resolved sets policyVersion and resolvedAt', () => {
      const base = service.empty('run-1');
      const event = makeEvent({
        type: 'policy.resolved',
        subject: { kind: 'policy', id: 'policy.fraud.majority' },
        data: {
          policyVersion: 'policy.fraud.majority',
          decodedPayload: {
            policyVersion: 'policy.fraud.majority',
            description: 'Majority veto policy'
          }
        }
      });

      const result = service.applyEvents(base, [event]);

      expect(result.policy.policyVersion).toBe('policy.fraud.majority');
      expect(result.policy.policyDescription).toBe('Majority veto policy');
      expect(result.policy.resolvedAt).toBe('2026-01-01T00:00:00Z');
    });

    it('policy.commitment.evaluated appends to commitmentEvaluations', () => {
      const base = service.empty('run-1');
      const event = makeEvent({
        type: 'policy.commitment.evaluated',
        subject: { kind: 'policy', id: 'commit-1' },
        data: {
          decodedPayload: {
            commitmentId: 'commit-1',
            decision: 'allow',
            reasons: ['quorum met', 'no blocking objections']
          }
        }
      });

      const result = service.applyEvents(base, [event]);

      expect(result.policy.commitmentEvaluations).toHaveLength(1);
      expect(result.policy.commitmentEvaluations[0]).toEqual({
        commitmentId: 'commit-1',
        decision: 'allow',
        reasons: ['quorum met', 'no blocking objections'],
        ts: '2026-01-01T00:00:00Z'
      });
    });

    it('policy.commitment.evaluated with deny decision', () => {
      const base = service.empty('run-1');
      const event = makeEvent({
        type: 'policy.commitment.evaluated',
        subject: { kind: 'policy', id: 'commit-2' },
        data: {
          decodedPayload: {
            commitmentId: 'commit-2',
            decision: 'deny',
            reasons: ['voting threshold not met: 1 of 3 required']
          }
        }
      });

      const result = service.applyEvents(base, [event]);

      expect(result.policy.commitmentEvaluations).toHaveLength(1);
      expect(result.policy.commitmentEvaluations[0].decision).toBe('deny');
      expect(result.policy.commitmentEvaluations[0].reasons).toEqual(['voting threshold not met: 1 of 3 required']);
    });

    it('commitmentEvaluations capped at 50 entries', () => {
      const base = service.empty('run-1');
      // Pre-fill 50 entries
      base.policy.commitmentEvaluations = Array.from({ length: 50 }, (_, i) => ({
        commitmentId: `commit-${i}`,
        decision: 'allow' as const,
        reasons: [],
        ts: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z`
      }));

      const event = makeEvent({
        type: 'policy.commitment.evaluated',
        subject: { kind: 'policy', id: 'commit-new' },
        data: {
          decodedPayload: {
            commitmentId: 'commit-new',
            decision: 'deny',
            reasons: ['cap test']
          }
        }
      });

      const result = service.applyEvents(base, [event]);

      expect(result.policy.commitmentEvaluations).toHaveLength(50);
      expect(result.policy.commitmentEvaluations[49].commitmentId).toBe('commit-new');
    });

    it('llm.call.completed appends to llm.calls and updates totals (§8.1)', () => {
      const base = service.empty('run-1');
      const event = makeEvent({
        type: 'llm.call.completed',
        ts: '2026-04-14T00:00:01Z',
        subject: { kind: 'message', id: 'msg-1' },
        data: {
          sender: 'agent-a',
          messageId: 'msg-1',
          decodedPayload: {
            model: 'gpt-4o-mini',
            promptTokens: 120,
            completionTokens: 45,
            totalTokens: 165,
            latencyMs: 890,
            estimatedCostUsd: 0.00042
          }
        }
      });

      const result = service.applyEvents(base, [event]);

      expect(result.llm.calls).toHaveLength(1);
      expect(result.llm.calls[0]).toMatchObject({
        participantId: 'agent-a',
        model: 'gpt-4o-mini',
        promptTokens: 120,
        completionTokens: 45,
        totalTokens: 165,
        latencyMs: 890,
        messageId: 'msg-1'
      });
      expect(result.llm.totals).toEqual({
        callCount: 1,
        promptTokens: 120,
        completionTokens: 45,
        totalTokens: 165,
        estimatedCostUsd: 0.00042
      });
    });

    it('llm.calls are capped at 100 entries (§8.1)', () => {
      const base = service.empty('run-1');
      for (let i = 0; i < 100; i++) {
        base.llm.calls.push({
          participantId: `a-${i}`,
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
          ts: '2026-04-14T00:00:00Z'
        });
      }
      const event = makeEvent({
        type: 'llm.call.completed',
        data: { sender: 'new-agent', decodedPayload: { promptTokens: 5, completionTokens: 5 } }
      });

      const result = service.applyEvents(base, [event]);

      expect(result.llm.calls).toHaveLength(100);
      expect(result.llm.calls[result.llm.calls.length - 1].participantId).toBe('new-agent');
      expect(result.llm.calls[0].participantId).toBe('a-1');
    });

    it('empty projection has default policy state', () => {
      const projection = service.empty('run-1');

      expect(projection.policy).toEqual({
        policyVersion: '',
        commitmentEvaluations: []
      });
    });

    it('session.bound with expectedCommitments populates policy.expectedCommitments (§2.4)', () => {
      const base = service.empty('run-1');
      const event = makeEvent({
        type: 'session.bound',
        data: {
          sessionId: 'session-1',
          expectedCommitments: [
            { id: 'commit-approve', title: 'Approve', requiredRoles: ['voter'] },
            { id: 'commit-reject', title: 'Reject', requiredRoles: ['voter'] }
          ]
        }
      });

      const result = service.applyEvents(base, [event]);

      expect(result.policy.expectedCommitments).toHaveLength(2);
      expect(result.policy.expectedCommitments?.[0]).toEqual({
        id: 'commit-approve',
        title: 'Approve',
        requiredRoles: ['voter']
      });
      expect(result.policy.quorumStatus).toBe('pending');
    });

    it('Vote contributions accumulate voteTally with derived quorum (§2.5)', () => {
      const base = service.empty('run-1');
      base.participants.push(
        { participantId: 'voter-a', status: 'idle', role: 'voter' },
        { participantId: 'voter-b', status: 'idle', role: 'voter' },
        { participantId: 'voter-c', status: 'idle', role: 'voter' }
      );

      const events: CanonicalEvent[] = [
        makeEvent({
          type: 'proposal.updated',
          seq: 1,
          data: {
            sender: 'voter-a',
            messageType: 'Vote',
            decodedPayload: { proposalId: 'prop-1', vote: 'APPROVE' }
          }
        }),
        makeEvent({
          type: 'proposal.updated',
          id: 'evt-2',
          seq: 2,
          data: {
            sender: 'voter-b',
            messageType: 'Vote',
            decodedPayload: { proposalId: 'prop-1', vote: 'REJECT' }
          }
        }),
        makeEvent({
          type: 'proposal.updated',
          id: 'evt-3',
          seq: 3,
          data: {
            sender: 'voter-c',
            messageType: 'Vote',
            decodedPayload: { proposalId: 'prop-1', vote: 'APPROVE' }
          }
        })
      ];

      const result = service.applyEvents(base, events);

      expect(result.policy.voteTally).toHaveLength(1);
      const entry = result.policy.voteTally![0];
      expect(entry).toEqual({
        commitmentId: 'prop-1',
        allow: 2,
        deny: 1,
        threshold: 2,
        quorum: { required: 3, cast: 3 }
      });
      expect(result.policy.quorumStatus).toBe('pending');
    });

    it('policy.commitment.evaluated with decision=allow flips quorumStatus to reached (§2.5)', () => {
      const base = service.empty('run-1');
      const event = makeEvent({
        type: 'policy.commitment.evaluated',
        subject: { kind: 'policy', id: 'commit-1' },
        data: {
          decodedPayload: { commitmentId: 'commit-1', decision: 'allow', reasons: ['ok'] }
        }
      });

      const result = service.applyEvents(base, [event]);

      expect(result.policy.quorumStatus).toBe('reached');
    });

    it('run.failed with no allow evaluations flips quorumStatus to failed (§2.5)', () => {
      const base = service.empty('run-1');
      base.run.status = 'running';
      base.policy.quorumStatus = 'pending';

      const result = service.applyEvents(base, [
        makeEvent({ type: 'run.failed', data: { status: 'failed', error: 'boom' } })
      ]);

      expect(result.policy.quorumStatus).toBe('failed');
    });
  });
});
