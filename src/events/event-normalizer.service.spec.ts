import { EventNormalizerService } from './event-normalizer.service';
import { ProtoRegistryService } from '../runtime/proto-registry.service';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { RawRuntimeEvent, NormalizeContext } from '../contracts/runtime';
import { RunDescriptor } from '../contracts/control-plane';

function makeContext(overrides?: Partial<NormalizeContext>): NormalizeContext {
  return {
    knownParticipants: new Set<string>(),
    runtimeSessionId: 'session-1',
    execution: {
      mode: 'live',
      runtime: { kind: 'rust', version: '0.1.0' },
      session: {
        modeName: 'decision',
        modeVersion: '1.0.0',
        configurationVersion: '1.0.0',
        ttlMs: 30000,
        participants: [{ id: 'agent-a' }, { id: 'agent-b' }],
      },
    } as RunDescriptor,
    ...overrides,
  };
}

function makeEnvelope(overrides?: Record<string, unknown>) {
  return {
    macpVersion: '1.0',
    mode: 'macp.mode.decision.v1',
    messageType: 'Signal',
    messageId: 'msg-1',
    sessionId: 'session-1',
    sender: 'agent-a',
    timestampUnixMs: Date.now(),
    payload: Buffer.from('{}'),
    ...overrides,
  };
}

describe('EventNormalizerService', () => {
  let service: EventNormalizerService;
  let protoRegistry: jest.Mocked<ProtoRegistryService>;

  beforeEach(() => {
    protoRegistry = {
      decodeKnown: jest.fn().mockReturnValue(undefined),
      getKnownTypeName: jest.fn().mockReturnValue(undefined),
    } as unknown as jest.Mocked<ProtoRegistryService>;

    service = new EventNormalizerService(
      protoRegistry,
      { inboundMessagesTotal: { inc: jest.fn() } } as unknown as InstrumentationService,
      { isActive: () => false, redact: <T>(v: T) => v } as any,
    );
  });

  describe('stream-status events', () => {
    it('should produce session.stream.opened event', () => {
      const raw: RawRuntimeEvent = {
        kind: 'stream-status',
        receivedAt: '2026-01-01T00:00:00.000Z',
        streamStatus: { status: 'opened', detail: 'connected' },
      };
      const ctx = makeContext();

      const events = service.normalize('run-1', raw, ctx);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('session.stream.opened');
      expect(events[0].runId).toBe('run-1');
      expect(events[0].subject).toEqual({ kind: 'session', id: 'session-1' });
      expect(events[0].data).toEqual(
        expect.objectContaining({ status: 'opened', detail: 'connected' }),
      );
    });
  });

  describe('session-snapshot events', () => {
    it('should produce session.state.changed with snapshot state', () => {
      const raw: RawRuntimeEvent = {
        kind: 'session-snapshot',
        receivedAt: '2026-01-01T00:00:00.000Z',
        sessionSnapshot: {
          sessionId: 'session-1',
          mode: 'decision',
          state: 'SESSION_STATE_OPEN',
          startedAtUnixMs: 1000,
          expiresAtUnixMs: 31000,
          modeVersion: '1.0.0',
          configurationVersion: '1.0.0',
        },
      };
      const ctx = makeContext();

      const events = service.normalize('run-1', raw, ctx);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('session.state.changed');
      expect(events[0].subject).toEqual({ kind: 'session', id: 'session-1' });
      expect(events[0].data).toEqual(
        expect.objectContaining({
          sessionId: 'session-1',
          state: 'SESSION_STATE_OPEN',
          modeName: 'decision',
          modeVersion: '1.0.0',
        }),
      );
    });

    it('should return empty array when session-snapshot has no sessionSnapshot data', () => {
      const raw: RawRuntimeEvent = {
        kind: 'session-snapshot',
        receivedAt: '2026-01-01T00:00:00.000Z',
      };
      const ctx = makeContext();

      const events = service.normalize('run-1', raw, ctx);

      expect(events).toHaveLength(0);
    });
  });

  describe('stream-envelope events', () => {
    it('should produce message.received event', () => {
      const envelope = makeEnvelope({ messageType: 'Signal' });
      const raw: RawRuntimeEvent = {
        kind: 'stream-envelope',
        receivedAt: '2026-01-01T00:00:00.000Z',
        envelope,
      };
      const ctx = makeContext({ knownParticipants: new Set(['agent-a']) });

      const events = service.normalize('run-1', raw, ctx);

      const messageReceived = events.find((e) => e.type === 'message.received');
      expect(messageReceived).toBeDefined();
      expect(messageReceived!.subject).toEqual({ kind: 'message', id: 'msg-1' });
      expect(messageReceived!.data).toEqual(
        expect.objectContaining({
          messageType: 'Signal',
          messageId: 'msg-1',
          sender: 'agent-a',
          sessionId: 'session-1',
        }),
      );
    });

    it('should generate participant.seen event for unknown participant', () => {
      const envelope = makeEnvelope({ sender: 'new-agent' });
      const raw: RawRuntimeEvent = {
        kind: 'stream-envelope',
        receivedAt: '2026-01-01T00:00:00.000Z',
        envelope,
      };
      const ctx = makeContext();

      const events = service.normalize('run-1', raw, ctx);

      const participantSeen = events.find((e) => e.type === 'participant.seen');
      expect(participantSeen).toBeDefined();
      expect(participantSeen!.subject).toEqual({ kind: 'participant', id: 'new-agent' });
      expect(participantSeen!.data).toEqual(
        expect.objectContaining({ participantId: 'new-agent' }),
      );
      expect(ctx.knownParticipants.has('new-agent')).toBe(true);
    });

    it('should NOT generate participant.seen event for already known participant', () => {
      const envelope = makeEnvelope({ sender: 'agent-a' });
      const raw: RawRuntimeEvent = {
        kind: 'stream-envelope',
        receivedAt: '2026-01-01T00:00:00.000Z',
        envelope,
      };
      const ctx = makeContext({ knownParticipants: new Set(['agent-a']) });

      const events = service.normalize('run-1', raw, ctx);

      const participantSeen = events.find((e) => e.type === 'participant.seen');
      expect(participantSeen).toBeUndefined();
    });

    it('should produce signal.emitted derived event for Signal messageType', () => {
      const envelope = makeEnvelope({ messageType: 'Signal' });
      const raw: RawRuntimeEvent = {
        kind: 'stream-envelope',
        receivedAt: '2026-01-01T00:00:00.000Z',
        envelope,
      };
      const ctx = makeContext({ knownParticipants: new Set(['agent-a']) });

      const events = service.normalize('run-1', raw, ctx);

      const signalEmitted = events.find((e) => e.type === 'signal.emitted');
      expect(signalEmitted).toBeDefined();
      expect(signalEmitted!.subject).toEqual({ kind: 'signal', id: 'msg-1' });
      expect(signalEmitted!.data).toEqual(
        expect.objectContaining({
          messageType: 'Signal',
          sender: 'agent-a',
        }),
      );
    });

    it('should produce signal.acknowledged derived event for SignalAck messageType (§1.2)', () => {
      const decoded = { signalId: 'sig-42', acknowledgedBy: 'agent-a' };
      protoRegistry.decodeKnown.mockReturnValue(decoded);

      const envelope = makeEnvelope({ messageType: 'SignalAck' });
      const raw: RawRuntimeEvent = {
        kind: 'stream-envelope',
        receivedAt: '2026-01-01T00:00:00.000Z',
        envelope,
      };
      const ctx = makeContext({ knownParticipants: new Set(['agent-a']) });

      const events = service.normalize('run-1', raw, ctx);

      const ack = events.find((e) => e.type === 'signal.acknowledged');
      expect(ack).toBeDefined();
      expect(ack!.subject).toEqual({ kind: 'signal', id: 'sig-42' });
    });

    it('synthesizes llm.call.completed when message metadata carries llmCall (§3.3)', () => {
      const decoded = {
        some_payload: 'foo',
        metadata: {
          llmCall: { model: 'gpt-4o-mini', promptTokens: 123, completionTokens: 45, latencyMs: 890 },
        },
      };
      protoRegistry.decodeKnown.mockReturnValue(decoded);

      const envelope = makeEnvelope({ messageType: 'Proposal' });
      const raw: RawRuntimeEvent = {
        kind: 'stream-envelope',
        receivedAt: '2026-04-14T00:00:00.000Z',
        envelope,
      };
      const ctx = makeContext({ knownParticipants: new Set(['agent-a']) });

      const events = service.normalize('run-1', raw, ctx);

      const llm = events.find((e) => e.type === 'llm.call.completed');
      expect(llm).toBeDefined();
      expect(llm!.data.decodedPayload).toMatchObject({
        model: 'gpt-4o-mini',
        promptTokens: 123,
        completionTokens: 45,
        totalTokens: 168,
        latencyMs: 890,
      });
    });

    it('synthesizes llm.call.completed from minimal tokenUsage shape (§3.3)', () => {
      protoRegistry.decodeKnown.mockReturnValue({
        tokenUsage: { promptTokens: 50, completionTokens: 10, model: 'claude-3-haiku' },
      });

      const envelope = makeEnvelope({ messageType: 'Evaluation' });
      const raw: RawRuntimeEvent = {
        kind: 'stream-envelope',
        receivedAt: '2026-04-14T00:00:00.000Z',
        envelope,
      };
      const ctx = makeContext({ knownParticipants: new Set(['agent-a']) });

      const events = service.normalize('run-1', raw, ctx);

      const llm = events.find((e) => e.type === 'llm.call.completed');
      expect(llm).toBeDefined();
      expect(llm!.data.decodedPayload).toMatchObject({
        model: 'claude-3-haiku',
        promptTokens: 50,
        completionTokens: 10,
      });
    });

    it('does NOT synthesize llm.call.completed when metadata is absent (§3.3)', () => {
      protoRegistry.decodeKnown.mockReturnValue({ anything: 'else' });

      const envelope = makeEnvelope({ messageType: 'Proposal' });
      const raw: RawRuntimeEvent = {
        kind: 'stream-envelope',
        receivedAt: '2026-04-14T00:00:00.000Z',
        envelope,
      };
      const ctx = makeContext({ knownParticipants: new Set(['agent-a']) });

      const events = service.normalize('run-1', raw, ctx);

      expect(events.find((e) => e.type === 'llm.call.completed')).toBeUndefined();
    });

    it('SignalAcknowledged messageType also maps to signal.acknowledged (§1.2)', () => {
      const decoded = { signal_id: 'sig-99' };
      protoRegistry.decodeKnown.mockReturnValue(decoded);

      const envelope = makeEnvelope({ messageType: 'SignalAcknowledged' });
      const raw: RawRuntimeEvent = {
        kind: 'stream-envelope',
        receivedAt: '2026-01-01T00:00:00.000Z',
        envelope,
      };
      const ctx = makeContext({ knownParticipants: new Set(['agent-a']) });

      const events = service.normalize('run-1', raw, ctx);

      const ack = events.find((e) => e.type === 'signal.acknowledged');
      expect(ack).toBeDefined();
      expect(ack!.subject).toEqual({ kind: 'signal', id: 'sig-99' });
    });

    it('should produce decision.finalized but NOT session.state.changed for Commitment messageType', () => {
      const decoded = { commitmentId: 'commit-1', action: 'approve' };
      protoRegistry.decodeKnown.mockReturnValue(decoded);

      const envelope = makeEnvelope({ messageType: 'Commitment' });
      const raw: RawRuntimeEvent = {
        kind: 'stream-envelope',
        receivedAt: '2026-01-01T00:00:00.000Z',
        envelope,
      };
      const ctx = makeContext({ knownParticipants: new Set(['agent-a']) });

      const events = service.normalize('run-1', raw, ctx);

      const decisionFinalized = events.find((e) => e.type === 'decision.finalized');
      expect(decisionFinalized).toBeDefined();
      expect(decisionFinalized!.subject).toEqual({ kind: 'decision', id: 'commit-1' });

      // Commitment should NOT synthesize session.state.changed — only runtime authority can do that
      const stateChanged = events.find((e) => e.type === 'session.state.changed');
      expect(stateChanged).toBeUndefined();
    });

    it('should produce proposal.created derived event for Proposal messageType', () => {
      const envelope = makeEnvelope({ messageType: 'Proposal' });
      const raw: RawRuntimeEvent = {
        kind: 'stream-envelope',
        receivedAt: '2026-01-01T00:00:00.000Z',
        envelope,
      };
      const ctx = makeContext({ knownParticipants: new Set(['agent-a']) });

      const events = service.normalize('run-1', raw, ctx);

      const proposalCreated = events.find((e) => e.type === 'proposal.created');
      expect(proposalCreated).toBeDefined();
      expect(proposalCreated!.subject).toEqual({ kind: 'proposal', id: 'msg-1' });
    });

    it('should produce proposal.updated for response message types like Evaluation', () => {
      const envelope = makeEnvelope({ messageType: 'Evaluation' });
      const raw: RawRuntimeEvent = {
        kind: 'stream-envelope',
        receivedAt: '2026-01-01T00:00:00.000Z',
        envelope,
      };
      const ctx = makeContext({ knownParticipants: new Set(['agent-a']) });

      const events = service.normalize('run-1', raw, ctx);

      const proposalUpdated = events.find((e) => e.type === 'proposal.updated');
      expect(proposalUpdated).toBeDefined();
      expect(proposalUpdated!.subject).toEqual({ kind: 'proposal', id: 'msg-1' });
    });
  });

  describe('progress from task lifecycle', () => {
    it('should emit additional progress.reported for TaskUpdate with progress field', () => {
      const decoded = { progress: 50, status: 'halfway done' };
      protoRegistry.decodeKnown.mockReturnValue(decoded);

      const envelope = makeEnvelope({ messageType: 'TaskUpdate' });
      const raw: RawRuntimeEvent = {
        kind: 'stream-envelope',
        receivedAt: '2026-01-01T00:00:00.000Z',
        envelope,
      };
      const ctx = makeContext({ knownParticipants: new Set(['agent-a']) });

      const events = service.normalize('run-1', raw, ctx);

      const progressEvents = events.filter((e) => e.type === 'progress.reported');
      expect(progressEvents).toHaveLength(1);
      expect(progressEvents[0].data.decodedPayload).toEqual(
        expect.objectContaining({ percentage: 50, message: 'halfway done' }),
      );
    });

    it('should emit progress.reported at 100% for TaskComplete', () => {
      protoRegistry.decodeKnown.mockReturnValue({});

      const envelope = makeEnvelope({ messageType: 'TaskComplete' });
      const raw: RawRuntimeEvent = {
        kind: 'stream-envelope',
        receivedAt: '2026-01-01T00:00:00.000Z',
        envelope,
      };
      const ctx = makeContext({ knownParticipants: new Set(['agent-a']) });

      const events = service.normalize('run-1', raw, ctx);

      const progressEvents = events.filter((e) => e.type === 'progress.reported');
      expect(progressEvents).toHaveLength(1);
      expect(progressEvents[0].data.decodedPayload).toEqual(
        expect.objectContaining({ percentage: 100, message: 'completed' }),
      );
    });

    it('should emit progress.reported with failure status for TaskFail', () => {
      protoRegistry.decodeKnown.mockReturnValue({ reason: 'out of memory' });

      const envelope = makeEnvelope({ messageType: 'TaskFail' });
      const raw: RawRuntimeEvent = {
        kind: 'stream-envelope',
        receivedAt: '2026-01-01T00:00:00.000Z',
        envelope,
      };
      const ctx = makeContext({ knownParticipants: new Set(['agent-a']) });

      const events = service.normalize('run-1', raw, ctx);

      const progressEvents = events.filter((e) => e.type === 'progress.reported');
      expect(progressEvents).toHaveLength(1);
      expect(progressEvents[0].data.decodedPayload).toEqual(
        expect.objectContaining({ message: 'out of memory' }),
      );
    });
  });

  describe('ambient Progress messages', () => {
    // Note: deriveEventType('Progress') returns 'progress.reported', producing a generic
    // progress event with subject={kind:'message'}. The ambient handler adds a SECOND
    // progress.reported with subject={kind:'participant'} when decoded is truthy.

    it('should emit ambient progress.reported with participant subject when decoded', () => {
      const decoded = { progress: 0.5, message: 'halfway there', progressToken: 'tok-1', total: 100 };
      protoRegistry.decodeKnown.mockReturnValue(decoded);

      const envelope = makeEnvelope({ messageType: 'Progress', sender: 'agent-a' });
      const raw: RawRuntimeEvent = {
        kind: 'stream-envelope',
        receivedAt: '2026-01-01T00:00:00.000Z',
        envelope,
      };
      const ctx = makeContext({ knownParticipants: new Set(['agent-a']) });

      const events = service.normalize('run-1', raw, ctx);

      // Two progress.reported: one from deriveEventType, one from ambient handler
      const progressEvents = events.filter((e) => e.type === 'progress.reported');
      expect(progressEvents.length).toBeGreaterThanOrEqual(2);

      // The ambient handler event has participant subject
      const ambientProgress = progressEvents.find((e) => e.subject?.kind === 'participant');
      expect(ambientProgress).toBeDefined();
      expect(ambientProgress!.subject).toEqual({ kind: 'participant', id: 'agent-a' });
      const payload = (ambientProgress!.data as Record<string, unknown>).decodedPayload as Record<string, unknown>;
      expect(payload.percentage).toBe(50); // 0.5 * 100
      expect(payload.message).toBe('halfway there');
      expect(payload.progressToken).toBe('tok-1');
      expect(payload.total).toBe(100);
    });

    it('should handle missing progress value as undefined percentage', () => {
      const decoded = { message: 'working on it' };
      protoRegistry.decodeKnown.mockReturnValue(decoded);

      const envelope = makeEnvelope({ messageType: 'Progress', sender: 'agent-b' });
      const raw: RawRuntimeEvent = {
        kind: 'stream-envelope',
        receivedAt: '2026-01-01T00:00:00.000Z',
        envelope,
      };
      const ctx = makeContext({ knownParticipants: new Set(['agent-b']) });

      const events = service.normalize('run-1', raw, ctx);

      const ambientProgress = events.find(
        (e) => e.type === 'progress.reported' && e.subject?.kind === 'participant',
      );
      expect(ambientProgress).toBeDefined();
      const payload = (ambientProgress!.data as Record<string, unknown>).decodedPayload as Record<string, unknown>;
      expect(payload.percentage).toBeUndefined();
      expect(payload.message).toBe('working on it');
    });

    it('should default empty message to empty string', () => {
      const decoded = { progress: 0.75 };
      protoRegistry.decodeKnown.mockReturnValue(decoded);

      const envelope = makeEnvelope({ messageType: 'Progress', sender: 'agent-a' });
      const raw: RawRuntimeEvent = {
        kind: 'stream-envelope',
        receivedAt: '2026-01-01T00:00:00.000Z',
        envelope,
      };
      const ctx = makeContext({ knownParticipants: new Set(['agent-a']) });

      const events = service.normalize('run-1', raw, ctx);

      const ambientProgress = events.find(
        (e) => e.type === 'progress.reported' && e.subject?.kind === 'participant',
      );
      expect(ambientProgress).toBeDefined();
      const payload = (ambientProgress!.data as Record<string, unknown>).decodedPayload as Record<string, unknown>;
      expect(payload.message).toBe('');
    });

    it('should NOT emit ambient progress when decoded is undefined (only generic derive)', () => {
      protoRegistry.decodeKnown.mockReturnValue(undefined);

      const envelope = makeEnvelope({ messageType: 'Progress', sender: 'agent-a' });
      const raw: RawRuntimeEvent = {
        kind: 'stream-envelope',
        receivedAt: '2026-01-01T00:00:00.000Z',
        envelope,
      };
      const ctx = makeContext({ knownParticipants: new Set(['agent-a']) });

      const events = service.normalize('run-1', raw, ctx);

      // Generic derive still produces a progress.reported with message subject
      const genericProgress = events.filter(
        (e) => e.type === 'progress.reported' && e.subject?.kind === 'message',
      );
      expect(genericProgress.length).toBeGreaterThanOrEqual(1);

      // But no ambient progress with participant subject
      const ambientProgress = events.filter(
        (e) => e.type === 'progress.reported' && e.subject?.kind === 'participant',
      );
      expect(ambientProgress).toHaveLength(0);
    });

    it('should convert progress=1 to percentage=100', () => {
      const decoded = { progress: 1.0, message: 'done' };
      protoRegistry.decodeKnown.mockReturnValue(decoded);

      const envelope = makeEnvelope({ messageType: 'Progress', sender: 'agent-a' });
      const raw: RawRuntimeEvent = {
        kind: 'stream-envelope',
        receivedAt: '2026-01-01T00:00:00.000Z',
        envelope,
      };
      const ctx = makeContext({ knownParticipants: new Set(['agent-a']) });

      const events = service.normalize('run-1', raw, ctx);

      const ambientProgress = events.find(
        (e) => e.type === 'progress.reported' && e.subject?.kind === 'participant',
      );
      expect(ambientProgress).toBeDefined();
      const payload = (ambientProgress!.data as Record<string, unknown>).decodedPayload as Record<string, unknown>;
      expect(payload.percentage).toBe(100);
    });
  });

  describe('policy lifecycle events', () => {
    it('should emit policy.resolved for PolicyResolved messageType', () => {
      const decoded = { policyId: 'policy.fraud.majority', policyVersion: 'policy.fraud.majority', description: 'Majority veto' };
      protoRegistry.decodeKnown.mockReturnValue(decoded);

      const envelope = makeEnvelope({ messageType: 'PolicyResolved', sender: 'runtime' });
      const raw: RawRuntimeEvent = {
        kind: 'stream-envelope',
        receivedAt: '2026-01-01T00:00:00.000Z',
        envelope,
      };
      const ctx = makeContext({ knownParticipants: new Set(['runtime']) });

      const events = service.normalize('run-1', raw, ctx);

      // Find the specific policy handler event (subject.kind === 'policy'), not the generic derived event
      const policyEvent = events.find((e) => e.type === 'policy.resolved' && e.subject?.kind === 'policy');
      expect(policyEvent).toBeDefined();
      expect(policyEvent!.subject).toEqual({ kind: 'policy', id: 'policy.fraud.majority' });
      expect(policyEvent!.data.policyVersion).toBe('policy.fraud.majority');
    });

    it('should emit policy.commitment.evaluated for PolicyCommitmentEvaluated messageType', () => {
      const decoded = { commitmentId: 'commit-1', decision: 'allow', reasons: ['quorum met'] };
      protoRegistry.decodeKnown.mockReturnValue(decoded);

      const envelope = makeEnvelope({ messageType: 'PolicyCommitmentEvaluated', sender: 'runtime' });
      const raw: RawRuntimeEvent = {
        kind: 'stream-envelope',
        receivedAt: '2026-01-01T00:00:00.000Z',
        envelope,
      };
      const ctx = makeContext({ knownParticipants: new Set(['runtime']) });

      const events = service.normalize('run-1', raw, ctx);

      const evalEvent = events.find((e) => e.type === 'policy.commitment.evaluated' && e.subject?.kind === 'policy');
      expect(evalEvent).toBeDefined();
      expect(evalEvent!.subject).toEqual({ kind: 'policy', id: 'commit-1' });
    });

    it('should emit policy.denied for PolicyDenied messageType', () => {
      const decoded = { commitmentId: 'commit-1', reason: 'quorum not met' };
      protoRegistry.decodeKnown.mockReturnValue(decoded);

      const envelope = makeEnvelope({ messageType: 'PolicyDenied', sender: 'runtime' });
      const raw: RawRuntimeEvent = {
        kind: 'stream-envelope',
        receivedAt: '2026-01-01T00:00:00.000Z',
        envelope,
      };
      const ctx = makeContext({ knownParticipants: new Set(['runtime']) });

      const events = service.normalize('run-1', raw, ctx);

      const denyEvent = events.find((e) => e.type === 'policy.denied' && e.subject?.kind === 'policy');
      expect(denyEvent).toBeDefined();
      expect(denyEvent!.subject).toEqual({ kind: 'policy', id: 'commit-1' });
    });

    it('should emit policy.denied from send-ack with POLICY_DENIED error code', () => {
      const raw: RawRuntimeEvent = {
        kind: 'send-ack',
        receivedAt: '2026-01-01T00:00:00.000Z',
        ack: {
          ok: false,
          duplicate: false,
          messageId: 'msg-1',
          sessionId: 'session-1',
          acceptedAtUnixMs: Date.now(),
          sessionState: 'SESSION_STATE_OPEN',
          error: {
            code: 'POLICY_DENIED',
            message: 'Voting quorum not met: 1 of 3 required'
          }
        },
      };
      const ctx = makeContext();

      const events = service.normalize('run-1', raw, ctx);

      expect(events).toHaveLength(2); // message.sent + policy.denied
      const messageSent = events.find((e) => e.type === 'message.sent');
      const policyDenied = events.find((e) => e.type === 'policy.denied');
      expect(messageSent).toBeDefined();
      expect(policyDenied).toBeDefined();
      expect(policyDenied!.subject).toEqual({ kind: 'policy', id: 'msg-1' });
      expect(policyDenied!.data.errorCode).toBe('POLICY_DENIED');
    });

    it('should NOT emit policy.denied from send-ack with non-policy error', () => {
      const raw: RawRuntimeEvent = {
        kind: 'send-ack',
        receivedAt: '2026-01-01T00:00:00.000Z',
        ack: {
          ok: false,
          duplicate: false,
          messageId: 'msg-1',
          sessionId: 'session-1',
          acceptedAtUnixMs: Date.now(),
          sessionState: 'SESSION_STATE_OPEN',
          error: {
            code: 'INVALID_SESSION_ID',
            message: 'Session not found'
          }
        },
      };
      const ctx = makeContext();

      const events = service.normalize('run-1', raw, ctx);

      expect(events).toHaveLength(1); // only message.sent
      expect(events[0].type).toBe('message.sent');
    });
  });

  describe('unknown event kinds', () => {
    it('should produce message.sent for send-ack kind', () => {
      const raw: RawRuntimeEvent = {
        kind: 'send-ack',
        receivedAt: '2026-01-01T00:00:00.000Z',
        ack: {
          ok: true,
          duplicate: false,
          messageId: 'msg-1',
          sessionId: 'session-1',
          acceptedAtUnixMs: Date.now(),
          sessionState: 'SESSION_STATE_OPEN',
        },
      };
      const ctx = makeContext();

      const events = service.normalize('run-1', raw, ctx);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('message.sent');
      expect(events[0].data.messageId).toBe('msg-1');
    });

    it('should return empty array for stream-envelope without envelope data', () => {
      const raw: RawRuntimeEvent = {
        kind: 'stream-envelope',
        receivedAt: '2026-01-01T00:00:00.000Z',
      };
      const ctx = makeContext();

      const events = service.normalize('run-1', raw, ctx);

      expect(events).toHaveLength(0);
    });
  });

  describe('event structure', () => {
    it('should set source to runtime with rawType', () => {
      const raw: RawRuntimeEvent = {
        kind: 'stream-status',
        receivedAt: '2026-01-01T00:00:00.000Z',
        streamStatus: { status: 'opened' },
      };
      const ctx = makeContext();

      const events = service.normalize('run-1', raw, ctx);

      expect(events[0].source).toEqual({
        kind: 'runtime',
        name: 'rust-runtime',
        rawType: 'stream-status',
      });
    });

    it('should set ts from rawEvent.receivedAt', () => {
      const ts = '2026-03-18T12:00:00.000Z';
      const raw: RawRuntimeEvent = {
        kind: 'stream-status',
        receivedAt: ts,
        streamStatus: { status: 'opened' },
      };
      const ctx = makeContext();

      const events = service.normalize('run-1', raw, ctx);

      expect(events[0].ts).toBe(ts);
    });

    it('should include a unique id and seq 0 on each event', () => {
      const raw: RawRuntimeEvent = {
        kind: 'stream-status',
        receivedAt: '2026-01-01T00:00:00.000Z',
        streamStatus: { status: 'opened' },
      };
      const ctx = makeContext();

      const events = service.normalize('run-1', raw, ctx);

      expect(events[0].id).toBeDefined();
      expect(typeof events[0].id).toBe('string');
      expect(events[0].seq).toBe(0);
    });
  });
});
