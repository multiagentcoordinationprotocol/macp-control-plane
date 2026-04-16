import { RunDescriptor } from '../../src/contracts/control-plane';
import {
  makeStreamEnvelope,
  RuntimeScript,
} from '../helpers/scripted-mock-runtime.provider';
import { testRuntimeKind } from '../helpers/runtime-kind';

/**
 * Observer-mode fixtures (direct-agent-auth CP-3).
 *
 * No `kickoff[]` — agents emit the Proposal/Evaluation/Vote/Commitment sequence
 * directly against the runtime. Tests verify the control-plane's observer sees them
 * and projects them correctly.
 */
export function decisionModeRequest(overrides?: Partial<RunDescriptor>): RunDescriptor {
  return {
    mode: 'sandbox',
    runtime: { kind: testRuntimeKind() },
    session: {
      modeName: 'macp.mode.decision.v1',
      modeVersion: '1.0.0',
      configurationVersion: '1.0.0',
      policyVersion: 'policy.default',
      ttlMs: 60000,
      participants: [{ id: 'proposer' }, { id: 'evaluator' }, { id: 'voter' }],
    },
    execution: {
      tags: ['integration-test', 'decision-mode'],
    },
    ...overrides,
  };
}

/** Happy path: Proposal → Evaluation → Vote → Commitment (outcome_positive: true). */
export function decisionHappyScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.decision.v1'],
    initiator: 'proposer',
    events: [
      {
        delayMs: 10,
        event: makeStreamEnvelope('macp.mode.decision.v1', 'Proposal', 'proposer', {
          proposalId: 'prop-1',
          option: 'Deploy feature X',
          rationale: 'Integration test proposal',
        }),
      },
      {
        delayMs: 10,
        event: makeStreamEnvelope('macp.mode.decision.v1', 'Evaluation', 'evaluator', {
          recommendation: 'APPROVE',
          rationale: 'Looks good',
        }),
      },
      {
        delayMs: 10,
        event: makeStreamEnvelope('macp.mode.decision.v1', 'Vote', 'voter', {
          vote: 'approve',
          rationale: 'Approved',
        }),
      },
      {
        delayMs: 10,
        event: makeStreamEnvelope('macp.mode.decision.v1', 'Commitment', 'proposer', {
          proposalId: 'prop-1',
          outcome: 'approved',
          finalized: true,
          outcome_positive: true,
          rationale: 'Consensus reached',
        }),
      },
    ],
  };
}

/** Objection flow: Proposal → Objection → revised Proposal → Evaluation → Vote → Commitment. */
export function decisionObjectionScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.decision.v1'],
    initiator: 'proposer',
    events: [
      {
        delayMs: 10,
        event: makeStreamEnvelope('macp.mode.decision.v1', 'Proposal', 'proposer', {
          proposalId: 'prop-2',
          option: 'Deploy feature Y',
          rationale: 'Initial',
        }),
      },
      {
        delayMs: 10,
        event: makeStreamEnvelope('macp.mode.decision.v1', 'Objection', 'evaluator', {
          severity: 'high',
          reason: 'Needs revision',
        }),
      },
      {
        delayMs: 10,
        event: makeStreamEnvelope('macp.mode.decision.v1', 'Evaluation', 'evaluator', {
          recommendation: 'APPROVE',
          rationale: 'Revised version approved',
        }),
      },
      {
        delayMs: 10,
        event: makeStreamEnvelope('macp.mode.decision.v1', 'Vote', 'voter', { vote: 'approve' }),
      },
      {
        delayMs: 10,
        event: makeStreamEnvelope('macp.mode.decision.v1', 'Commitment', 'proposer', {
          proposalId: 'prop-2',
          outcome: 'approved',
          finalized: true,
          outcome_positive: true,
        }),
      },
    ],
  };
}

/** Rejection: Proposal → Vote(reject) — no Commitment emitted. */
export function decisionRejectionScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.decision.v1'],
    initiator: 'proposer',
    events: [
      {
        delayMs: 10,
        event: makeStreamEnvelope('macp.mode.decision.v1', 'Proposal', 'proposer', {
          proposalId: 'prop-3',
          option: 'Deploy feature Z',
          rationale: 'Speculative',
        }),
      },
      {
        delayMs: 10,
        event: makeStreamEnvelope('macp.mode.decision.v1', 'Vote', 'voter', {
          vote: 'reject',
          rationale: 'Insufficient evidence',
        }),
      },
    ],
  };
}
