import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CANONICAL_EVENT_TYPES } from '../contracts/control-plane';

/**
 * Invariant (Q1-4 / plans/quality-cleanup.md):
 *
 * Every `CanonicalEventType` declared in `CANONICAL_EVENT_TYPES` must have a
 * reducer branch in `ProjectionService.applyEvents`. If a new event type is
 * added to the union without a matching `case '...'` branch, this test fails —
 * preventing silently-dropped events in the UI projection.
 *
 * Scope choice: we parse the source file textually (`case 'foo'` literals)
 * rather than injecting a spy, because the reducer is a large switch and a
 * textual check catches additions without needing to wire every event type
 * through a full projection state to observe its effect.
 */
describe('Projection coverage invariant — every canonical event has a reducer', () => {
  const projectionSource = readFileSync(
    join(__dirname, 'projection.service.ts'),
    'utf8',
  );

  // A type is "covered" if the literal `case 'foo':` appears in projection.service.ts
  // OR if it's a documented intentional no-op.
  const EXEMPT_TYPES = new Set<string>([
    // Reserved type per RFC; not emitted by the default normalizer and not shown
    // in the UI projection (decision.finalized is the authoritative surface).
    'decision.proposed',
    // No dedicated projection branch — the UI renders this only via timeline
    // and graph which are populated uniformly for all envelope events.
    'session.stream.opened',
    // Tool events aren't reduced into the current RunStateProjection surface;
    // they appear in the raw canonical events list only.
    'tool.called',
    'tool.completed',
    // policy.denied is visible via the policy projection via commitment evaluations
    // and the event list; no dedicated reducer branch required today.
    'policy.denied',
  ]);

  for (const eventType of CANONICAL_EVENT_TYPES) {
    it(`'${eventType}' has a reducer branch (or is exempt)`, () => {
      if (EXEMPT_TYPES.has(eventType)) return; // documented exemption
      const needle = `case '${eventType}'`;
      expect(projectionSource).toContain(needle);
    });
  }
});
