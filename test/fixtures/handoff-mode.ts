import { ExecutionRequest } from '../../src/contracts/control-plane';
import {
  makeStreamOpened,
  makeStreamEnvelope,
  RuntimeScript
} from '../helpers/scripted-mock-runtime.provider';
import { testRuntimeKind } from '../helpers/runtime-kind';

export function handoffModeRequest(
  overrides?: Partial<ExecutionRequest>
): ExecutionRequest {
  return {
    mode: 'sandbox',
    runtime: { kind: testRuntimeKind() },
    session: {
      modeName: 'macp.mode.handoff.v1',
      modeVersion: '1.0.0',
      configurationVersion: '1.0.0',
      policyVersion: 'policy.default',
      ttlMs: 60000,
      participants: [
        { id: 'source', role: 'source_agent' },
        { id: 'target', role: 'target_agent' }
      ]
    },
    kickoff: [
      {
        from: 'source',
        to: ['target'],
        kind: 'request',
        messageType: 'HandoffOffer',
        payload: {
          reason: 'Specialized knowledge required',
          contextSummary: 'User needs help with billing'
        }
      }
    ],
    execution: {
      tags: ['integration-test', 'handoff-mode']
    },
    ...overrides
  };
}

/** Successful handoff: HandoffOffer -> HandoffContext -> HandoffAccept -> Commitment */
export function handoffAcceptScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.handoff.v1'],
    events: [
      { event: makeStreamOpened() },
      {
        trigger: {
          afterMessageType: 'HandoffContext',
          fromParticipant: 'source'
        },
        event: makeStreamEnvelope(
          'macp.mode.handoff.v1',
          'HandoffContext',
          'source',
          { conversationHistory: ['msg1', 'msg2'], metadata: { topic: 'billing' } }
        )
      },
      {
        trigger: {
          afterMessageType: 'HandoffAccept',
          fromParticipant: 'target'
        },
        event: makeStreamEnvelope(
          'macp.mode.handoff.v1',
          'HandoffAccept',
          'target',
          { acceptedAt: new Date().toISOString() }
        )
      },
      {
        trigger: { afterMessageType: 'HandoffAccept' },
        delayMs: 50,
        event: makeStreamEnvelope(
          'macp.mode.handoff.v1',
          'Commitment',
          'system',
          { outcome: 'handoff_completed', finalized: true, outcome_positive: true }
        )
      }
    ]
  };
}

/** Declined handoff: HandoffOffer -> HandoffDecline */
export function handoffDeclineScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.handoff.v1'],
    events: [
      { event: makeStreamOpened() },
      {
        trigger: {
          afterMessageType: 'HandoffDecline',
          fromParticipant: 'target'
        },
        event: makeStreamEnvelope(
          'macp.mode.handoff.v1',
          'HandoffDecline',
          'target',
          { reason: 'Not available' }
        )
      }
    ]
  };
}
