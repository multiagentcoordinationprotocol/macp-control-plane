import { RunDescriptor } from '../../src/contracts/control-plane';
import {
  makeStreamEnvelope,
  RuntimeScript,
} from '../helpers/scripted-mock-runtime.provider';
import { testRuntimeKind } from '../helpers/runtime-kind';

export function proposalModeRequest(overrides?: Partial<RunDescriptor>): RunDescriptor {
  return {
    mode: 'sandbox',
    runtime: { kind: testRuntimeKind() },
    session: {
      modeName: 'macp.mode.proposal.v1',
      modeVersion: '1.0.0',
      configurationVersion: '1.0.0',
      policyVersion: 'policy.default',
      ttlMs: 60000,
      participants: [{ id: 'author' }, { id: 'reviewer' }],
    },
    execution: { tags: ['integration-test', 'proposal-mode'] },
    ...overrides,
  };
}

export function proposalAcceptScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.proposal.v1'],
    initiator: 'author',
    events: [
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.proposal.v1', 'Proposal', 'author', {
          proposalId: 'prop-1',
          title: 'Integration test proposal',
          body: 'This is a test proposal',
        }),
      },
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.proposal.v1', 'Accept', 'reviewer', {
          proposalId: 'prop-1',
          comment: 'LGTM',
        }),
      },
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.proposal.v1', 'Commitment', 'author', {
          proposalId: 'prop-1',
          outcome: 'accepted',
          finalized: true,
          outcome_positive: true,
        }),
      },
    ],
  };
}

export function proposalCounterScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.proposal.v1'],
    initiator: 'author',
    events: [
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.proposal.v1', 'Proposal', 'author', {
          proposalId: 'prop-1',
          title: 'Initial',
        }),
      },
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.proposal.v1', 'CounterProposal', 'reviewer', {
          proposalId: 'prop-2',
          supersedesProposalId: 'prop-1',
          title: 'Better approach',
        }),
      },
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.proposal.v1', 'Accept', 'author', {
          proposalId: 'prop-2',
        }),
      },
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.proposal.v1', 'Commitment', 'author', {
          proposalId: 'prop-2',
          outcome: 'accepted',
          finalized: true,
          outcome_positive: true,
        }),
      },
    ],
  };
}

export function proposalRejectScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.proposal.v1'],
    initiator: 'author',
    events: [
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.proposal.v1', 'Proposal', 'author', {
          proposalId: 'prop-1',
          title: 'Rejected proposal',
        }),
      },
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.proposal.v1', 'Reject', 'reviewer', {
          proposalId: 'prop-1',
          reason: 'Out of scope',
          terminal: true,
        }),
      },
    ],
  };
}
