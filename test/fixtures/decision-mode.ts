import { ExecutionRequest } from '../../src/contracts/control-plane';
import {
  makeStreamOpened,
  makeStreamEnvelope,
  RuntimeScript,
  ScriptedEvent
} from '../helpers/scripted-mock-runtime.provider';

export function decisionModeRequest(
  overrides?: Partial<ExecutionRequest>
): ExecutionRequest {
  return {
    mode: 'sandbox',
    runtime: { kind: 'scripted-mock' },
    session: {
      modeName: 'macp.mode.decision.v1',
      modeVersion: '1.0.0',
      configurationVersion: '1.0.0',
      policyVersion: 'policy.default',
      ttlMs: 60000,
      participants: [
        { id: 'proposer', role: 'proposer' },
        { id: 'evaluator', role: 'evaluator' },
        { id: 'voter', role: 'voter' }
      ]
    },
    kickoff: [
      {
        from: 'proposer',
        to: ['evaluator', 'voter'],
        kind: 'proposal',
        messageType: 'Proposal',
        payload: {
          proposalId: 'prop-1',
          option: 'Deploy feature X',
          rationale: 'Integration test proposal'
        }
      }
    ],
    execution: {
      tags: ['integration-test', 'decision-mode']
    },
    ...overrides
  };
}

/**
 * Happy path: Proposal -> Evaluation -> Vote -> Commitment -> resolved
 * The runtime echoes messages as stream-envelope events and triggers
 * Commitment after receiving a Vote.
 */
export function decisionHappyScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.decision.v1'],
    events: [
      // Stream opens immediately
      { event: makeStreamOpened() },
      // After evaluator sends Evaluation, echo it back
      {
        trigger: { afterMessageType: 'Evaluation', fromParticipant: 'evaluator' },
        event: makeStreamEnvelope(
          'macp.mode.decision.v1',
          'Evaluation',
          'evaluator',
          { recommendation: 'APPROVE', rationale: 'Looks good' }
        )
      },
      // After voter sends Vote, echo it and then emit Commitment
      {
        trigger: { afterMessageType: 'Vote', fromParticipant: 'voter' },
        event: makeStreamEnvelope(
          'macp.mode.decision.v1',
          'Vote',
          'voter',
          { vote: 'approve', rationale: 'Approved' }
        )
      },
      {
        trigger: { afterMessageType: 'Vote' },
        delayMs: 50,
        event: makeStreamEnvelope(
          'macp.mode.decision.v1',
          'Commitment',
          'system',
          {
            proposalId: 'prop-1',
            outcome: 'approved',
            finalized: true,
            outcome_positive: true,
            rationale: 'Consensus reached'
          }
        )
      }
    ]
  };
}

/**
 * Objection flow: Proposal -> Objection -> revised Proposal -> Evaluation -> Vote -> Commitment
 */
export function decisionObjectionScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.decision.v1'],
    events: [
      { event: makeStreamOpened() },
      {
        trigger: { afterMessageType: 'Objection', fromParticipant: 'evaluator' },
        event: makeStreamEnvelope(
          'macp.mode.decision.v1',
          'Objection',
          'evaluator',
          { severity: 'high', reason: 'Needs revision' }
        )
      },
      {
        trigger: { afterMessageType: 'Evaluation', fromParticipant: 'evaluator' },
        event: makeStreamEnvelope(
          'macp.mode.decision.v1',
          'Evaluation',
          'evaluator',
          { recommendation: 'APPROVE', rationale: 'Revised version approved' }
        )
      },
      {
        trigger: { afterMessageType: 'Vote', fromParticipant: 'voter' },
        event: makeStreamEnvelope(
          'macp.mode.decision.v1',
          'Vote',
          'voter',
          { vote: 'approve' }
        )
      },
      {
        trigger: { afterMessageType: 'Vote' },
        delayMs: 50,
        event: makeStreamEnvelope(
          'macp.mode.decision.v1',
          'Commitment',
          'system',
          { proposalId: 'prop-2', outcome: 'approved', finalized: true, outcome_positive: true }
        )
      }
    ]
  };
}

/**
 * Rejection: Proposal -> Vote (reject) -> session does not resolve (no Commitment)
 */
export function decisionRejectionScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.decision.v1'],
    events: [
      { event: makeStreamOpened() },
      {
        trigger: { afterMessageType: 'Vote', fromParticipant: 'voter' },
        event: makeStreamEnvelope(
          'macp.mode.decision.v1',
          'Vote',
          'voter',
          { vote: 'reject', rationale: 'Insufficient evidence' }
        )
      }
    ]
  };
}
