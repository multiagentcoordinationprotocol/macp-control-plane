import { RunDescriptor } from '../../src/contracts/control-plane';
import {
  makeStreamEnvelope,
  RuntimeScript,
} from '../helpers/scripted-mock-runtime.provider';
import { testRuntimeKind } from '../helpers/runtime-kind';

export function quorumModeRequest(overrides?: Partial<RunDescriptor>): RunDescriptor {
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
        { id: 'initiator' },
        { id: 'voter_a' },
        { id: 'voter_b' },
        { id: 'voter_c' },
      ],
    },
    execution: { tags: ['integration-test', 'quorum-mode'] },
    ...overrides,
  };
}

export function quorumReachedScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.quorum.v1'],
    initiator: 'initiator',
    events: [
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.quorum.v1', 'ApprovalRequest', 'initiator', {
          requestId: 'approval-1',
          subject: 'Release v2.0',
          requiredApprovals: 2,
        }),
      },
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.quorum.v1', 'Approve', 'voter_a', {
          requestId: 'approval-1',
          comment: 'Ship it',
        }),
      },
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.quorum.v1', 'Approve', 'voter_b', {
          requestId: 'approval-1',
        }),
      },
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.quorum.v1', 'Commitment', 'initiator', {
          requestId: 'approval-1',
          outcome: 'approved',
          approvalCount: 2,
          finalized: true,
          outcome_positive: true,
        }),
      },
    ],
  };
}

export function quorumRejectedScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.quorum.v1'],
    initiator: 'initiator',
    events: [
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.quorum.v1', 'ApprovalRequest', 'initiator', {
          requestId: 'approval-1',
        }),
      },
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.quorum.v1', 'Approve', 'voter_a', {
          requestId: 'approval-1',
        }),
      },
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.quorum.v1', 'Reject', 'voter_b', {
          requestId: 'approval-1',
          reason: 'Not ready',
        }),
      },
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.quorum.v1', 'Reject', 'voter_c', {
          requestId: 'approval-1',
          reason: 'Missing tests',
        }),
      },
    ],
  };
}

export function quorumAbstentionScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.quorum.v1'],
    initiator: 'initiator',
    events: [
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.quorum.v1', 'ApprovalRequest', 'initiator', {
          requestId: 'approval-1',
        }),
      },
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.quorum.v1', 'Approve', 'voter_a', {
          requestId: 'approval-1',
        }),
      },
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.quorum.v1', 'Abstain', 'voter_b', {
          requestId: 'approval-1',
          reason: 'No opinion',
        }),
      },
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.quorum.v1', 'Approve', 'voter_c', {
          requestId: 'approval-1',
        }),
      },
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.quorum.v1', 'Commitment', 'initiator', {
          requestId: 'approval-1',
          outcome: 'approved',
          approvalCount: 2,
          finalized: true,
          outcome_positive: true,
        }),
      },
    ],
  };
}
