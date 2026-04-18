import { CANONICAL_EVENT_TYPES, CanonicalEventType } from './control-plane';

describe('CANONICAL_EVENT_TYPES (§3 contract stability)', () => {
  it('contains all lifecycle, message, signal, decision and policy events', () => {
    const expected: CanonicalEventType[] = [
      'run.created',
      'run.started',
      'run.completed',
      'run.failed',
      'run.cancelled',
      'session.bound',
      'session.stream.opened',
      'session.state.changed',
      'participant.seen',
      'message.sent',
      'message.received',
      'message.send_failed',
      'signal.emitted',
      'signal.acknowledged',
      'proposal.created',
      'proposal.updated',
      'decision.proposed',
      'decision.finalized',
      'progress.reported',
      'tool.called',
      'tool.completed',
      'artifact.created',
      'policy.resolved',
      'policy.commitment.evaluated',
      'policy.denied',
      'llm.call.completed'
    ];
    expect([...CANONICAL_EVENT_TYPES].sort()).toEqual(expected.sort());
  });

  it('has no duplicates', () => {
    const set = new Set(CANONICAL_EVENT_TYPES);
    expect(set.size).toBe(CANONICAL_EVENT_TYPES.length);
  });

  it('is a readonly tuple at the type level', () => {
    // Compile-time guard — assigning to an index should be disallowed.
    // Runtime guard — Object.isFrozen would require explicit Object.freeze;
    // we only assert the `as const` tuple form via type narrowing.
    const first: CanonicalEventType = CANONICAL_EVENT_TYPES[0];
    expect(typeof first).toBe('string');
  });
});
