import { RunDescriptor } from '../../src/contracts/control-plane';
import {
  makeStreamEnvelope,
  RuntimeScript,
} from '../helpers/scripted-mock-runtime.provider';
import { testRuntimeKind } from '../helpers/runtime-kind';

export function taskModeRequest(overrides?: Partial<RunDescriptor>): RunDescriptor {
  return {
    mode: 'sandbox',
    runtime: { kind: testRuntimeKind() },
    session: {
      modeName: 'macp.mode.task.v1',
      modeVersion: '1.0.0',
      configurationVersion: '1.0.0',
      policyVersion: 'policy.default',
      ttlMs: 60000,
      participants: [{ id: 'requester' }, { id: 'worker' }],
    },
    execution: { tags: ['integration-test', 'task-mode'] },
    ...overrides,
  };
}

/** Happy path: TaskRequest → TaskAccept → TaskUpdate → TaskComplete → Commitment. */
export function taskHappyScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.task.v1'],
    initiator: 'requester',
    events: [
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.task.v1', 'TaskRequest', 'requester', {
          taskId: 'task-1',
          description: 'Process integration test data',
          priority: 'normal',
        }),
      },
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.task.v1', 'TaskAccept', 'worker', {
          taskId: 'task-1',
        }),
      },
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.task.v1', 'TaskUpdate', 'worker', {
          taskId: 'task-1',
          progress: 0.5,
          message: 'Processing...',
        }),
      },
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.task.v1', 'TaskComplete', 'worker', {
          taskId: 'task-1',
          output: { result: 'success', itemsProcessed: 42 },
        }),
      },
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.task.v1', 'Commitment', 'requester', {
          taskId: 'task-1',
          outcome: 'completed',
          finalized: true,
          outcome_positive: true,
        }),
      },
    ],
  };
}

/** Rejection: TaskRequest → TaskReject. */
export function taskRejectionScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.task.v1'],
    initiator: 'requester',
    events: [
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.task.v1', 'TaskRequest', 'requester', {
          taskId: 'task-1',
          description: 'Will be rejected',
        }),
      },
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.task.v1', 'TaskReject', 'worker', {
          taskId: 'task-1',
          reason: 'capacity',
        }),
      },
    ],
  };
}

/** Failure: TaskRequest → TaskAccept → TaskFail. */
export function taskFailureScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.task.v1'],
    initiator: 'requester',
    events: [
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.task.v1', 'TaskRequest', 'requester', {
          taskId: 'task-1',
        }),
      },
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.task.v1', 'TaskAccept', 'worker', {
          taskId: 'task-1',
        }),
      },
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.task.v1', 'TaskFail', 'worker', {
          taskId: 'task-1',
          error: 'Processing failed',
          retryable: true,
        }),
      },
    ],
  };
}

/**
 * Task mode allows an external orchestrator: the session initiator is NOT in the
 * `participants` pool (macp-runtime v0.5.0). The control plane does no initiator
 * membership validation, so the orchestrator must simply appear as another
 * participant in the projection.
 */
export function taskOrchestratorRequest(overrides?: Partial<RunDescriptor>): RunDescriptor {
  const base = taskModeRequest();
  return {
    ...base,
    session: { ...base.session, participants: [{ id: 'worker' }] },
    execution: { tags: ['integration-test', 'task-mode', 'external-orchestrator'] },
    ...overrides,
  };
}

/** TaskRequest from an orchestrator outside the participant pool → worker accepts and completes. */
export function taskOrchestratorScript(): RuntimeScript {
  return {
    supportedModes: ['macp.mode.task.v1'],
    initiator: 'orchestrator',
    events: [
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.task.v1', 'TaskRequest', 'orchestrator', {
          taskId: 'task-orch-1',
          description: 'Dispatched by an external orchestrator',
        }),
      },
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.task.v1', 'TaskAccept', 'worker', { taskId: 'task-orch-1' }),
      },
      {
        delayMs: 5,
        event: makeStreamEnvelope('macp.mode.task.v1', 'TaskComplete', 'worker', {
          taskId: 'task-orch-1',
          output: { result: 'success' },
        }),
      },
    ],
  };
}
