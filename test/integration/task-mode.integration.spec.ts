import { createTestApp, TestAppContext } from '../helpers/test-app';
import {
  taskModeRequest as taskModeRequestBase,
  taskHappyScript,
  taskRejectionScript,
  taskFailureScript
} from '../fixtures/task-mode';

const isRealRuntime =
  process.env.INTEGRATION_RUNTIME === 'docker' ||
  process.env.INTEGRATION_RUNTIME === 'remote';

/** Returns the execution request, adjusting for the active runtime mode */
function taskModeRequest(overrides?: Record<string, unknown>) {
  const base = taskModeRequestBase(overrides as any);
  if (isRealRuntime) {
    base.runtime = { kind: 'rust' };
    // Real runtime requires proto-encoded kickoff payloads
    if (base.kickoff) {
      for (const k of base.kickoff) {
        if (k.payload && !k.payloadEnvelope) {
          k.payloadEnvelope = {
            encoding: 'proto' as const,
            proto: {
              typeName: 'macp.modes.task.v1.TaskRequestPayload',
              value: k.payload
            }
          };
          delete k.payload;
        }
      }
    }
  }
  return base;
}

/**
 * Build a message body with proto encoding when running against the real runtime.
 * The real Rust runtime requires proto-encoded payloads, while the mock accepts JSON.
 */
function msg(
  from: string,
  messageType: string,
  protoTypeName: string,
  payload: Record<string, unknown>,
  to?: string[]
): Record<string, unknown> {
  const base: Record<string, unknown> = { from, messageType };
  if (to) base.to = to;

  if (isRealRuntime) {
    // Real runtime: proto-encoded via payloadEnvelope
    base.payloadEnvelope = {
      encoding: 'proto',
      proto: { typeName: protoTypeName, value: payload }
    };
  } else {
    // Mock runtime: plain JSON
    base.payload = payload;
  }
  return base;
}

describe('Task Mode (integration)', () => {
  let ctx: TestAppContext;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  afterAll(async () => {
    if (ctx) await ctx.app.close();
  });

  describe('Happy Path — Request, Accept, Update, Complete', () => {
    beforeAll(async () => {
      ctx = await createTestApp(isRealRuntime ? undefined : taskHappyScript());
    });

    it('creates a task mode run', async () => {
      const { runId } = await ctx.client.createRun(taskModeRequest());
      expect(runId).toBeDefined();

      await sleep(500);

      const run = await ctx.client.getRun(runId) as any;
      expect(['binding_session', 'running', 'completed']).toContain(run.status);
    });

    it('worker accepts and completes task', async () => {
      const { runId } = await ctx.client.createRun(taskModeRequest());
      await sleep(500);

      // Worker accepts
      await ctx.client.sendMessage(
        runId,
        msg('worker', 'TaskAccept', 'macp.modes.task.v1.TaskAcceptPayload', {
          taskId: 'task-1'
        }, ['requester'])
      );
      await sleep(200);

      // Worker sends progress update
      await ctx.client.sendMessage(
        runId,
        msg('worker', 'TaskUpdate', 'macp.modes.task.v1.TaskUpdatePayload', {
          taskId: 'task-1',
          progress: 0.5,
          message: 'Half done'
        }, ['requester'])
      );
      await sleep(200);

      // Worker completes
      await ctx.client.sendMessage(
        runId,
        msg('worker', 'TaskComplete', 'macp.modes.task.v1.TaskCompletePayload', {
          taskId: 'task-1',
          output: { result: 'success', itemsProcessed: 42 }
        }, ['requester'])
      );

      await sleep(1000);

      const run = await ctx.client.getRun(runId) as any;
      expect(['running', 'completed']).toContain(run.status);
    });

    it('tracks task progress in projection', async () => {
      const { runId } = await ctx.client.createRun(taskModeRequest());
      await sleep(500);

      await ctx.client.sendMessage(
        runId,
        msg('worker', 'TaskAccept', 'macp.modes.task.v1.TaskAcceptPayload', {
          taskId: 'task-1'
        }, ['requester'])
      );
      await sleep(200);

      await ctx.client.sendMessage(
        runId,
        msg('worker', 'TaskUpdate', 'macp.modes.task.v1.TaskUpdatePayload', {
          taskId: 'task-1',
          progress: 0.5,
          message: 'Processing...'
        }, ['requester'])
      );
      await sleep(500);

      const state = await ctx.client.getState(runId) as any;
      expect(state.participants).toBeDefined();
      expect(state.participants.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Task Rejection', () => {
    beforeAll(async () => {
      if (ctx) await ctx.app.close();
      ctx = await createTestApp(isRealRuntime ? undefined : taskRejectionScript());
    });

    it('worker rejects task', async () => {
      const { runId } = await ctx.client.createRun(taskModeRequest());
      await sleep(500);

      await ctx.client.sendMessage(
        runId,
        msg('worker', 'TaskReject', 'macp.modes.task.v1.TaskRejectPayload', {
          taskId: 'task-1',
          reason: 'capacity'
        }, ['requester'])
      );

      await sleep(1000);

      const events = await ctx.client.listEvents(runId) as any[];
      const sentEvents = events.filter((e: any) => e.type === 'message.sent');
      expect(sentEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Task Failure', () => {
    beforeAll(async () => {
      if (ctx) await ctx.app.close();
      ctx = await createTestApp(isRealRuntime ? undefined : taskFailureScript());
    });

    it('worker accepts then fails task', async () => {
      const { runId } = await ctx.client.createRun(taskModeRequest());
      await sleep(500);

      await ctx.client.sendMessage(
        runId,
        msg('worker', 'TaskAccept', 'macp.modes.task.v1.TaskAcceptPayload', {
          taskId: 'task-1'
        }, ['requester'])
      );
      await sleep(200);

      await ctx.client.sendMessage(
        runId,
        msg('worker', 'TaskFail', 'macp.modes.task.v1.TaskFailPayload', {
          taskId: 'task-1',
          error: 'Processing failed',
          retryable: true
        }, ['requester'])
      );

      await sleep(1000);

      const events = await ctx.client.listEvents(runId) as any[];
      const sentEvents = events.filter((e: any) => e.type === 'message.sent');
      expect(sentEvents.length).toBeGreaterThanOrEqual(2);
    });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
