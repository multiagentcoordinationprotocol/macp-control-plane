import { ExecutionRequest } from '../../src/contracts/control-plane';
import {
  makeStreamOpened,
  makeStreamEnvelope,
  RuntimeScript
} from '../helpers/scripted-mock-runtime.provider';
import { testRuntimeKind } from '../helpers/runtime-kind';

export function proposalModeRequest(
  overrides?: Partial<ExecutionRequest>
): ExecutionRequest {
  return {
    mode: 'sandbox',
    runtime: { kind: testRuntimeKind() },
    session: {
      modeName: 'macp.mode.proposal.v1',
      modeVersion: '1.0.0',
      configurationVersion: '1.0.0',
      policyVersion: 'policy.default',
      ttlMs: 60000,
      participants: [
        { id: 'author', role: 'author' },
        { id: 'reviewer', role: 'reviewer' }
      ]
    },
    kickoff: [
      {
        from: 'author',
        to: ['reviewer'],
        kind: 'proposal',
        messageType: 'Proposal',
        payload: {
          proposalId: 'prop-1',
          title: 'Integration test proposal',
          body: 'This is a test proposal for integration testing'
        }
      }
    ],
    execution: {
      tags: ['integration-test', 'proposal-mode']
    },
    ...overrides
  };
}

/** Accept flow: Proposal -> Accept -> Commitment */
export function proposalAcceptScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.proposal.v1'],
    events: [
      { event: makeStreamOpened() },
      {
        trigger: { afterMessageType: 'Accept', fromParticipant: 'reviewer' },
        event: makeStreamEnvelope(
          'macp.mode.proposal.v1',
          'Accept',
          'reviewer',
          { proposalId: 'prop-1', comment: 'LGTM' }
        )
      },
      {
        trigger: { afterMessageType: 'Accept' },
        delayMs: 50,
        event: makeStreamEnvelope(
          'macp.mode.proposal.v1',
          'Commitment',
          'system',
          { proposalId: 'prop-1', outcome: 'accepted', finalized: true, outcome_positive: true }
        )
      }
    ]
  };
}

/** Counter-proposal flow: Proposal -> CounterProposal -> Accept -> Commitment */
export function proposalCounterScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.proposal.v1'],
    events: [
      { event: makeStreamOpened() },
      {
        trigger: { afterMessageType: 'CounterProposal', fromParticipant: 'reviewer' },
        event: makeStreamEnvelope(
          'macp.mode.proposal.v1',
          'CounterProposal',
          'reviewer',
          {
            proposalId: 'prop-2',
            supersedesProposalId: 'prop-1',
            title: 'Better approach'
          }
        )
      },
      {
        trigger: { afterMessageType: 'Accept', fromParticipant: 'author' },
        event: makeStreamEnvelope(
          'macp.mode.proposal.v1',
          'Accept',
          'author',
          { proposalId: 'prop-2' }
        )
      },
      {
        trigger: { afterMessageType: 'Accept' },
        delayMs: 50,
        event: makeStreamEnvelope(
          'macp.mode.proposal.v1',
          'Commitment',
          'system',
          { proposalId: 'prop-2', outcome: 'accepted', finalized: true, outcome_positive: true }
        )
      }
    ]
  };
}

/** Rejection flow: Proposal -> Reject */
export function proposalRejectScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.proposal.v1'],
    events: [
      { event: makeStreamOpened() },
      {
        trigger: { afterMessageType: 'Reject', fromParticipant: 'reviewer' },
        event: makeStreamEnvelope(
          'macp.mode.proposal.v1',
          'Reject',
          'reviewer',
          { proposalId: 'prop-1', reason: 'Out of scope', terminal: true }
        )
      }
    ]
  };
}
