import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { RunManagerService } from './run-manager.service';
import { RunRepository } from '../storage/run.repository';
import { RuntimeSessionRepository } from '../storage/runtime-session.repository';
import { ProjectionService } from '../projection/projection.service';
import { RunEventService } from '../events/run-event.service';
import { AuditService } from '../audit/audit.service';
import { TraceService } from '../telemetry/trace.service';
import { WebhookService } from '../webhooks/webhook.service';
import { MetricsService } from '../metrics/metrics.service';
import { EventRepository } from '../storage/event.repository';
import { ExecutionRequest, RunStateProjection } from '../contracts/control-plane';

function makeExecutionRequest(overrides?: Partial<ExecutionRequest>): ExecutionRequest {
  return {
    mode: 'live',
    runtime: { kind: 'rust', version: '0.1.0' },
    session: {
      modeName: 'decision',
      modeVersion: '1.0.0',
      configurationVersion: '1.0.0',
      ttlMs: 30000,
      participants: [
        { id: 'agent-a', role: 'proposer' },
        { id: 'agent-b', role: 'evaluator' },
      ],
    },
    ...overrides,
  };
}

function makeRunRecord(overrides?: Record<string, unknown>) {
  return {
    id: 'run-1',
    status: 'queued' as const,
    runtimeKind: 'rust',
    runtimeVersion: '0.1.0',
    createdAt: '2026-01-01T00:00:00.000Z',
    tags: [],
    metadata: {},
    ...overrides,
  };
}

function makeEmptyProjection(runId: string): RunStateProjection {
  return {
    run: { runId, status: 'queued' },
    participants: [],
    graph: { nodes: [], edges: [] },
    decision: {},
    signals: { signals: [] },
    progress: { entries: [] },
    timeline: { latestSeq: 0, totalEvents: 0, recent: [] },
    trace: { spanCount: 0, linkedArtifacts: [] },
    outboundMessages: { total: 0, queued: 0, accepted: 0, rejected: 0 },
  };
}

describe('RunManagerService', () => {
  let service: RunManagerService;
  let runRepository: jest.Mocked<RunRepository>;
  let runtimeSessionRepository: jest.Mocked<RuntimeSessionRepository>;
  let projectionService: jest.Mocked<ProjectionService>;
  let runEventService: jest.Mocked<RunEventService>;
  let traceService: jest.Mocked<TraceService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RunManagerService,
        {
          provide: RunRepository,
          useValue: {
            create: jest.fn(),
            findById: jest.fn(),
            findByIdempotencyKey: jest.fn(),
            update: jest.fn(),
            markStarted: jest.fn(),
            markRunning: jest.fn(),
            markCompleted: jest.fn(),
            markCancelled: jest.fn(),
            markFailed: jest.fn(),
          },
        },
        {
          provide: RuntimeSessionRepository,
          useValue: {
            upsert: jest.fn(),
          },
        },
        {
          provide: ProjectionService,
          useValue: {
            get: jest.fn(),
            empty: jest.fn(),
          },
        },
        {
          provide: RunEventService,
          useValue: {
            emitControlPlaneEvents: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: TraceService,
          useValue: {
            startRunTrace: jest.fn().mockReturnValue('trace-abc'),
            endRunTrace: jest.fn(),
          },
        },
        {
          provide: AuditService,
          useValue: {
            record: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: WebhookService,
          useValue: {
            fireEvent: jest.fn(),
          },
        },
        {
          provide: MetricsService,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: EventRepository,
          useValue: {
            listCanonicalByRun: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    service = module.get(RunManagerService);
    runRepository = module.get(RunRepository);
    runtimeSessionRepository = module.get(RuntimeSessionRepository);
    projectionService = module.get(ProjectionService);
    runEventService = module.get(RunEventService);
    traceService = module.get(TraceService);
  });

  describe('createRun', () => {
    it('should return existing run when idempotency key matches', async () => {
      const existing = makeRunRecord({ id: 'existing-run' });
      runRepository.findByIdempotencyKey.mockResolvedValue(existing as any);

      const request = makeExecutionRequest({
        execution: { idempotencyKey: 'key-123' },
      });

      const result = await service.createRun(request);

      expect(result).toBe(existing);
      expect(runRepository.findByIdempotencyKey).toHaveBeenCalledWith('key-123');
      expect(runRepository.create).not.toHaveBeenCalled();
      expect(runEventService.emitControlPlaneEvents).not.toHaveBeenCalled();
    });

    it('should create a new run when no idempotency key is provided', async () => {
      const created = makeRunRecord();
      runRepository.create.mockResolvedValue(created as any);

      const request = makeExecutionRequest();
      const result = await service.createRun(request);

      expect(result).toEqual(created);
      expect(runRepository.findByIdempotencyKey).not.toHaveBeenCalled();
      expect(runRepository.create).toHaveBeenCalledTimes(1);
      expect(traceService.startRunTrace).toHaveBeenCalled();
      expect(runEventService.emitControlPlaneEvents).toHaveBeenCalledWith(
        created.id,
        expect.arrayContaining([
          expect.objectContaining({ type: 'run.created' }),
        ]),
      );
    });

    it('should create a new run when idempotency key has no match', async () => {
      runRepository.findByIdempotencyKey.mockResolvedValue(null as any);
      const created = makeRunRecord();
      runRepository.create.mockResolvedValue(created as any);

      const request = makeExecutionRequest({
        execution: { idempotencyKey: 'new-key' },
      });
      const result = await service.createRun(request);

      expect(result).toEqual(created);
      expect(runRepository.findByIdempotencyKey).toHaveBeenCalledWith('new-key');
      expect(runRepository.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('markStarted', () => {
    it('should transition run to starting and emit run.started event', async () => {
      const run = makeRunRecord({
        status: 'starting',
        startedAt: '2026-01-01T00:01:00.000Z',
        traceId: 'trace-abc',
      });
      runRepository.markStarted.mockResolvedValue(run as any);

      const request = makeExecutionRequest();
      const result = await service.markStarted('run-1', request);

      expect(result).toEqual(run);
      expect(runRepository.markStarted).toHaveBeenCalledWith('run-1');
      expect(runEventService.emitControlPlaneEvents).toHaveBeenCalledWith(
        'run-1',
        expect.arrayContaining([
          expect.objectContaining({
            type: 'run.started',
            data: expect.objectContaining({ status: 'starting' }),
          }),
        ]),
      );
    });
  });

  describe('markCompleted', () => {
    it('should return existing run without emitting events if already completed', async () => {
      const completedRun = makeRunRecord({
        status: 'completed',
        endedAt: '2026-01-01T00:05:00.000Z',
      });
      runRepository.findById.mockResolvedValue(completedRun as any);

      const result = await service.markCompleted('run-1');

      expect(result).toEqual(completedRun);
      expect(runRepository.markCompleted).not.toHaveBeenCalled();
      expect(runEventService.emitControlPlaneEvents).not.toHaveBeenCalled();
    });

    it('should transition to completed and emit run.completed event', async () => {
      const runningRun = makeRunRecord({ status: 'running' });
      runRepository.findById.mockResolvedValue(runningRun as any);

      const completedRun = makeRunRecord({
        status: 'completed',
        endedAt: '2026-01-01T00:05:00.000Z',
        traceId: 'trace-abc',
        runtimeSessionId: 'sess-1',
      });
      runRepository.markCompleted.mockResolvedValue(completedRun as any);

      const result = await service.markCompleted('run-1');

      expect(result).toEqual(completedRun);
      expect(runRepository.markCompleted).toHaveBeenCalledWith('run-1');
      expect(runEventService.emitControlPlaneEvents).toHaveBeenCalledWith(
        'run-1',
        expect.arrayContaining([
          expect.objectContaining({
            type: 'run.completed',
            data: expect.objectContaining({ status: 'completed' }),
          }),
        ]),
      );
    });
  });

  describe('markFailed', () => {
    it('should return existing run without emitting events if already failed', async () => {
      const failedRun = makeRunRecord({ status: 'failed' });
      runRepository.findById.mockResolvedValue(failedRun as any);

      const result = await service.markFailed('run-1', new Error('boom'));

      expect(result).toEqual(failedRun);
      expect(runRepository.markFailed).not.toHaveBeenCalled();
      expect(runEventService.emitControlPlaneEvents).not.toHaveBeenCalled();
    });

    it('should transition to failed and emit run.failed event with error message', async () => {
      const runningRun = makeRunRecord({ status: 'running' });
      runRepository.findById.mockResolvedValue(runningRun as any);

      const failedRun = makeRunRecord({
        status: 'failed',
        endedAt: '2026-01-01T00:05:00.000Z',
        traceId: 'trace-abc',
      });
      runRepository.markFailed.mockResolvedValue(failedRun as any);

      const result = await service.markFailed('run-1', new Error('something broke'));

      expect(result).toEqual(failedRun);
      expect(runRepository.markFailed).toHaveBeenCalledWith('run-1', 'RUN_FAILED', 'something broke');
      expect(runEventService.emitControlPlaneEvents).toHaveBeenCalledWith(
        'run-1',
        expect.arrayContaining([
          expect.objectContaining({
            type: 'run.failed',
            data: expect.objectContaining({
              status: 'failed',
              error: 'something broke',
            }),
          }),
        ]),
      );
    });
  });

  describe('markCancelled', () => {
    it('should return existing run without emitting events if already cancelled', async () => {
      const cancelledRun = makeRunRecord({ status: 'cancelled' });
      runRepository.findById.mockResolvedValue(cancelledRun as any);

      const result = await service.markCancelled('run-1');

      expect(result).toEqual(cancelledRun);
      expect(runRepository.markCancelled).not.toHaveBeenCalled();
      expect(runEventService.emitControlPlaneEvents).not.toHaveBeenCalled();
    });
  });

  describe('getRun', () => {
    it('should throw NotFoundException when run does not exist', async () => {
      runRepository.findById.mockResolvedValue(null as any);

      await expect(service.getRun('nonexistent')).rejects.toThrow(NotFoundException);
      await expect(service.getRun('nonexistent')).rejects.toThrow('run nonexistent not found');
    });

    it('should return run when it exists', async () => {
      const run = makeRunRecord();
      runRepository.findById.mockResolvedValue(run as any);

      const result = await service.getRun('run-1');
      expect(result).toEqual(run);
    });
  });

  describe('getState', () => {
    it('should return empty projection when no projection exists', async () => {
      const run = makeRunRecord();
      runRepository.findById.mockResolvedValue(run as any);
      projectionService.get.mockResolvedValue(null);
      const emptyProj = makeEmptyProjection('run-1');
      projectionService.empty.mockReturnValue(emptyProj);

      const result = await service.getState('run-1');

      expect(result).toEqual(emptyProj);
      expect(projectionService.get).toHaveBeenCalledWith('run-1');
      expect(projectionService.empty).toHaveBeenCalledWith('run-1');
    });

    it('should return existing projection when one exists', async () => {
      const run = makeRunRecord();
      runRepository.findById.mockResolvedValue(run as any);
      const projection = makeEmptyProjection('run-1');
      projection.run.status = 'running';
      projectionService.get.mockResolvedValue(projection);

      const result = await service.getState('run-1');

      expect(result).toEqual(projection);
      expect(projectionService.empty).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException if the run does not exist', async () => {
      runRepository.findById.mockResolvedValue(null as any);

      await expect(service.getState('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });
});
