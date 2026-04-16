import { RunDescriptor } from '../../src/contracts/control-plane';
import {
  makeStreamEnvelope,
  RuntimeScript,
} from '../helpers/scripted-mock-runtime.provider';
import { testRuntimeKind } from '../helpers/runtime-kind';

export function handoffModeRequest(overrides?: Partial<RunDescriptor>): RunDescriptor {
  return {
    mode: 'sandbox',
    runtime: { kind: testRuntimeKind() },
    session: {
      modeName: 'macp.mode.handoff.v1',
      modeVersion: '1.0.0',
      configurationVersion: '1.0.0',
      policyVersion: 'policy.default',
      ttlMs: 60000,
      participants: [{ id: 'source' }, { id: 'target' }],
    },
    execution: { tags: ['integration-test', 'handoff-mode'] },
    ...overrides,
  };
}

export function handoffAcceptScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.handoff.v1'],
    initiator: 'source',
    events: [
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.handoff.v1', 'HandoffOffer', 'source', {
          reason: 'Specialized knowledge required',
          contextSummary: 'User needs help with billing',
        }),
      },
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.handoff.v1', 'HandoffContext', 'source', {
          conversationHistory: ['msg1', 'msg2'],
          metadata: { topic: 'billing' },
        }),
      },
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.handoff.v1', 'HandoffAccept', 'target', {
          acceptedAt: new Date().toISOString(),
        }),
      },
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.handoff.v1', 'Commitment', 'source', {
          outcome: 'handoff_completed',
          finalized: true,
          outcome_positive: true,
        }),
      },
    ],
  };
}

export function handoffDeclineScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.handoff.v1'],
    initiator: 'source',
    events: [
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.handoff.v1', 'HandoffOffer', 'source', {
          reason: 'Specialized',
        }),
      },
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.handoff.v1', 'HandoffDecline', 'target', {
          reason: 'Not available',
        }),
      },
    ],
  };
}
