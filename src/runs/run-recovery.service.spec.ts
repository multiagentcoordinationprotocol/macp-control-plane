import { RunRecoveryService } from './run-recovery.service';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseService } from '../db/database.service';
import { RunEventService } from '../events/run-event.service';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { RunRepository } from '../storage/run.repository';
import { RuntimeSessionRepository } from '../storage/runtime-session.repository';
import { RunManagerService } from './run-manager.service';
import { StreamConsumerService } from './stream-consumer.service';

describe('RunRecoveryService', () => {
  let service: RunRecoveryService;
  let mockConfig: Partial<AppConfigService>;
  let mockDatabase: { tryAdvisoryLock: jest.Mock; advisoryUnlock: jest.Mock };
  let mockRunRepo: { listActiveRuns: jest.Mock };
  let mockSessionRepo: { findByRunId: jest.Mock };
  let mockRunManager: { markRunning: jest.Mock; markFailed: jest.Mock };
  let mockStreamConsumer: { start: jest.Mock };
  let mockEventService: { emitControlPlaneEvents: jest.Mock };

  beforeEach(() => {
    mockConfig = { runRecoveryEnabled: true };
    mockDatabase = {
      tryAdvisoryLock: jest.fn().mockResolvedValue(true),
      advisoryUnlock: jest.fn().mockResolvedValue(undefined)
    };
    mockRunRepo = { listActiveRuns: jest.fn().mockResolvedValue([]) };
    mockSessionRepo = { findByRunId: jest.fn().mockResolvedValue(null) };
    mockRunManager = {
      markRunning: jest.fn().mockResolvedValue({}),
      markFailed: jest.fn().mockResolvedValue({})
    };
    mockStreamConsumer = { start: jest.fn().mockResolvedValue(undefined) };
    mockEventService = { emitControlPlaneEvents: jest.fn().mockResolvedValue([]) };

    service = new RunRecoveryService(
      mockConfig as AppConfigService,
      mockDatabase as unknown as DatabaseService,
      mockRunRepo as unknown as RunRepository,
      mockSessionRepo as unknown as RuntimeSessionRepository,
      mockRunManager as unknown as RunManagerService,
      mockStreamConsumer as unknown as StreamConsumerService,
      mockEventService as unknown as RunEventService,
      { recoveryTotal: { inc: jest.fn() } } as unknown as InstrumentationService
    );
  });

  it('skips recovery when disabled', async () => {
    const disabledService = new RunRecoveryService(
      { runRecoveryEnabled: false } as AppConfigService,
      mockDatabase as unknown as DatabaseService,
      mockRunRepo as unknown as RunRepository,
      mockSessionRepo as unknown as RuntimeSessionRepository,
      mockRunManager as unknown as RunManagerService,
      mockStreamConsumer as unknown as StreamConsumerService,
      mockEventService as unknown as RunEventService,
      { recoveryTotal: { inc: jest.fn() } } as unknown as InstrumentationService
    );
    await disabledService.onApplicationBootstrap();
    expect(mockRunRepo.listActiveRuns).not.toHaveBeenCalled();
  });

  it('does nothing when no active runs', async () => {
    await service.onApplicationBootstrap();
    expect(mockRunRepo.listActiveRuns).toHaveBeenCalled();
    expect(mockStreamConsumer.start).not.toHaveBeenCalled();
  });

  it('recovers a running run by starting stream consumer', async () => {
    const run = {
      id: 'run-1',
      status: 'running',
      runtimeKind: 'rust',
      runtimeSessionId: 'sess-1',
      lastEventSeq: 42,
      metadata: {
        executionRequest: {
          mode: 'live',
          runtime: { kind: 'rust' },
          session: {
            modeName: 'decision',
            modeVersion: '1.0',
            configurationVersion: 'v1',
            ttlMs: 60000,
            participants: [{ id: 'agent-1' }]
          }
        }
      }
    };
    mockRunRepo.listActiveRuns.mockResolvedValue([run]);
    mockSessionRepo.findByRunId.mockResolvedValue({
      initiatorParticipantId: 'agent-1',
      runtimeSessionId: 'sess-1'
    });

    await service.onApplicationBootstrap();

    expect(mockEventService.emitControlPlaneEvents).toHaveBeenCalledWith(
      'run-1',
      expect.arrayContaining([
        expect.objectContaining({
          type: 'session.stream.opened',
          data: expect.objectContaining({ status: 'recovered' })
        })
      ])
    );
    expect(mockStreamConsumer.start).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        runtimeSessionId: 'sess-1',
        subscriberId: 'agent-1',
        resumeFromSeq: 42,
        pollOnly: true
      })
    );
  });

  it('promotes binding_session to running before recovery', async () => {
    const run = {
      id: 'run-2',
      status: 'binding_session',
      runtimeKind: 'rust',
      runtimeSessionId: 'sess-2',
      lastEventSeq: 10,
      metadata: {
        executionRequest: {
          mode: 'live',
          runtime: { kind: 'rust' },
          session: {
            modeName: 'decision',
            modeVersion: '1.0',
            configurationVersion: 'v1',
            ttlMs: 60000,
            participants: [{ id: 'agent-1' }]
          }
        }
      }
    };
    mockRunRepo.listActiveRuns.mockResolvedValue([run]);

    await service.onApplicationBootstrap();

    expect(mockRunManager.markRunning).toHaveBeenCalledWith('run-2', 'sess-2');
  });

  it('marks run as failed when recovery fails', async () => {
    const run = {
      id: 'run-3',
      status: 'running',
      runtimeKind: 'rust',
      runtimeSessionId: 'sess-3',
      lastEventSeq: 0,
      metadata: {} // missing executionRequest
    };
    mockRunRepo.listActiveRuns.mockResolvedValue([run]);

    await service.onApplicationBootstrap();

    expect(mockRunManager.markFailed).toHaveBeenCalledWith(
      'run-3',
      expect.any(Error)
    );
  });

  it('does not crash if markFailed also fails', async () => {
    const run = {
      id: 'run-4',
      status: 'running',
      runtimeKind: 'rust',
      runtimeSessionId: null,
      lastEventSeq: 0,
      metadata: {
        executionRequest: {
          mode: 'live',
          runtime: { kind: 'rust' },
          session: {
            modeName: 'decision',
            modeVersion: '1.0',
            configurationVersion: 'v1',
            ttlMs: 60000,
            participants: [{ id: 'agent-1' }]
          }
        }
      }
    };
    mockRunRepo.listActiveRuns.mockResolvedValue([run]);
    mockSessionRepo.findByRunId.mockResolvedValue(null);
    mockRunManager.markFailed.mockRejectedValue(new Error('db down'));

    // Should not throw
    await service.onApplicationBootstrap();

    expect(mockRunManager.markFailed).toHaveBeenCalled();
  });
});
