import { ExecutionRequest } from '../../src/contracts/control-plane';
import {
  makeStreamOpened,
  makeStreamEnvelope,
  RuntimeScript
} from '../helpers/scripted-mock-runtime.provider';
import { testRuntimeKind } from '../helpers/runtime-kind';

export function quorumModeRequest(
  overrides?: Partial<ExecutionRequest>
): ExecutionRequest {
  return {
    mode: 'sandbox',
    runtime: { kind: testRuntimeKind() },
    session: {
      modeName: 'macp.mode.quorum.v1',
      modeVersion: '1.0.0',
      configurationVersion: '1.0.0',
      policyVersion: 'policy.default',
      ttlMs: 60000,
      participants: [
        { id: 'initiator', role: 'initiator' },
        { id: 'voter_a', role: 'voter' },
        { id: 'voter_b', role: 'voter' },
        { id: 'voter_c', role: 'voter' }
      ]
    },
    kickoff: [
      {
        from: 'initiator',
        to: ['voter_a', 'voter_b', 'voter_c'],
        kind: 'request',
        messageType: 'ApprovalRequest',
        payload: {
          requestId: 'approval-1',
          subject: 'Release v2.0',
          requiredApprovals: 2,
          description: 'Approve release of version 2.0'
        }
      }
    ],
    execution: {
      tags: ['integration-test', 'quorum-mode']
    },
    ...overrides
  };
}

/** Quorum reached: 2 of 3 approve -> Commitment */
export function quorumReachedScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.quorum.v1'],
    events: [
      { event: makeStreamOpened() },
      {
        trigger: { afterMessageType: 'Approve', fromParticipant: 'voter_a' },
        event: makeStreamEnvelope(
          'macp.mode.quorum.v1',
          'Approve',
          'voter_a',
          { requestId: 'approval-1', comment: 'Ship it' }
        )
      },
      {
        trigger: { afterMessageType: 'Approve', fromParticipant: 'voter_b' },
        event: makeStreamEnvelope(
          'macp.mode.quorum.v1',
          'Approve',
          'voter_b',
          { requestId: 'approval-1' }
        )
      },
      {
        trigger: { afterMessageType: 'Approve' },
        delayMs: 50,
        event: makeStreamEnvelope(
          'macp.mode.quorum.v1',
          'Commitment',
          'system',
          {
            requestId: 'approval-1',
            outcome: 'approved',
            approvalCount: 2,
            finalized: true,
            outcome_positive: true
          }
        )
      }
    ]
  };
}

/** Quorum not reached: 2 of 3 reject */
export function quorumRejectedScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.quorum.v1'],
    events: [
      { event: makeStreamOpened() },
      {
        trigger: { afterMessageType: 'Approve', fromParticipant: 'voter_a' },
        event: makeStreamEnvelope(
          'macp.mode.quorum.v1',
          'Approve',
          'voter_a',
          { requestId: 'approval-1' }
        )
      },
      {
        trigger: { afterMessageType: 'Reject', fromParticipant: 'voter_b' },
        event: makeStreamEnvelope(
          'macp.mode.quorum.v1',
          'Reject',
          'voter_b',
          { requestId: 'approval-1', reason: 'Not ready' }
        )
      },
      {
        trigger: { afterMessageType: 'Reject', fromParticipant: 'voter_c' },
        event: makeStreamEnvelope(
          'macp.mode.quorum.v1',
          'Reject',
          'voter_c',
          { requestId: 'approval-1', reason: 'Missing tests' }
        )
      }
    ]
  };
}

/** Abstention: Approve + Abstain + Approve -> quorum met */
export function quorumAbstentionScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.quorum.v1'],
    events: [
      { event: makeStreamOpened() },
      {
        trigger: { afterMessageType: 'Approve', fromParticipant: 'voter_a' },
        event: makeStreamEnvelope(
          'macp.mode.quorum.v1',
          'Approve',
          'voter_a',
          { requestId: 'approval-1' }
        )
      },
      {
        trigger: { afterMessageType: 'Abstain', fromParticipant: 'voter_b' },
        event: makeStreamEnvelope(
          'macp.mode.quorum.v1',
          'Abstain',
          'voter_b',
          { requestId: 'approval-1', reason: 'No opinion' }
        )
      },
      {
        trigger: { afterMessageType: 'Approve', fromParticipant: 'voter_c' },
        event: makeStreamEnvelope(
          'macp.mode.quorum.v1',
          'Approve',
          'voter_c',
          { requestId: 'approval-1' }
        )
      },
      {
        trigger: { afterMessageType: 'Approve' },
        delayMs: 50,
        event: makeStreamEnvelope(
          'macp.mode.quorum.v1',
          'Commitment',
          'system',
          {
            requestId: 'approval-1',
            outcome: 'approved',
            approvalCount: 2,
            finalized: true,
            outcome_positive: true
          }
        )
      }
    ]
  };
}
