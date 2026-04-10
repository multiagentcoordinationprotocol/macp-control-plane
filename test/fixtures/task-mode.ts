import { ExecutionRequest } from '../../src/contracts/control-plane';
import {
  makeStreamOpened,
  makeStreamEnvelope,
  RuntimeScript
} from '../helpers/scripted-mock-runtime.provider';
import { testRuntimeKind } from '../helpers/runtime-kind';

export function taskModeRequest(
  overrides?: Partial<ExecutionRequest>
): ExecutionRequest {
  return {
    mode: 'sandbox',
    runtime: { kind: testRuntimeKind() },
    session: {
      modeName: 'macp.mode.task.v1',
      modeVersion: '1.0.0',
      configurationVersion: '1.0.0',
      policyVersion: 'policy.default',
      ttlMs: 60000,
      participants: [
        { id: 'requester', role: 'requester' },
        { id: 'worker', role: 'worker' }
      ]
    },
    kickoff: [
      {
        from: 'requester',
        to: ['worker'],
        kind: 'request',
        messageType: 'TaskRequest',
        payload: {
          taskId: 'task-1',
          description: 'Process integration test data',
          priority: 'normal'
        }
      }
    ],
    execution: {
      tags: ['integration-test', 'task-mode']
    },
    ...overrides
  };
}

/**
 * Happy path: TaskRequest -> TaskAccept -> TaskUpdate (50%) -> TaskComplete -> resolved
 */
export function taskHappyScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.task.v1'],
    events: [
      { event: makeStreamOpened() },
      {
        trigger: { afterMessageType: 'TaskAccept', fromParticipant: 'worker' },
        event: makeStreamEnvelope('macp.mode.task.v1', 'TaskAccept', 'worker', {
          taskId: 'task-1',
          acceptedAt: new Date().toISOString()
        })
      },
      {
        trigger: { afterMessageType: 'TaskUpdate', fromParticipant: 'worker' },
        event: makeStreamEnvelope('macp.mode.task.v1', 'TaskUpdate', 'worker', {
          taskId: 'task-1',
          progress: 0.5,
          message: 'Processing...'
        })
      },
      {
        trigger: { afterMessageType: 'TaskComplete', fromParticipant: 'worker' },
        event: makeStreamEnvelope(
          'macp.mode.task.v1',
          'TaskComplete',
          'worker',
          {
            taskId: 'task-1',
            output: { result: 'success', itemsProcessed: 42 }
          }
        )
      },
      {
        trigger: { afterMessageType: 'TaskComplete' },
        delayMs: 50,
        event: makeStreamEnvelope('macp.mode.task.v1', 'Commitment', 'system', {
          taskId: 'task-1',
          outcome: 'completed',
          finalized: true,
          outcome_positive: true
        })
      }
    ]
  };
}

/**
 * Task rejection: TaskRequest -> TaskReject -> no completion
 */
export function taskRejectionScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.task.v1'],
    events: [
      { event: makeStreamOpened() },
      {
        trigger: { afterMessageType: 'TaskReject', fromParticipant: 'worker' },
        event: makeStreamEnvelope('macp.mode.task.v1', 'TaskReject', 'worker', {
          taskId: 'task-1',
          reason: 'capacity'
        })
      }
    ]
  };
}

/**
 * Task failure: TaskRequest -> TaskAccept -> TaskFail
 */
export function taskFailureScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.task.v1'],
    events: [
      { event: makeStreamOpened() },
      {
        trigger: { afterMessageType: 'TaskAccept', fromParticipant: 'worker' },
        event: makeStreamEnvelope('macp.mode.task.v1', 'TaskAccept', 'worker', {
          taskId: 'task-1'
        })
      },
      {
        trigger: { afterMessageType: 'TaskFail', fromParticipant: 'worker' },
        event: makeStreamEnvelope('macp.mode.task.v1', 'TaskFail', 'worker', {
          taskId: 'task-1',
          error: 'Processing failed',
          retryable: true
        })
      }
    ]
  };
}
