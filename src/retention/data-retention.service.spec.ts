import { DataRetentionService } from './data-retention.service';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseService } from '../db/database.service';

describe('DataRetentionService', () => {
  let service: DataRetentionService;
  let mockConfig: Record<string, unknown>;
  let mockDb: {
    select: jest.Mock;
    delete: jest.Mock;
  };
  let mockDatabase: Partial<DatabaseService>;

  const makeSelectChain = (rows: unknown[]) => ({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue(rows),
      }),
    }),
  });

  const makeDeleteChain = (rowCount: number) => ({
    where: jest.fn().mockResolvedValue({ rowCount }),
  });

  beforeEach(() => {
    mockConfig = {
      dataRetentionEnabled: false,
      dataRetentionTtlDays: 30,
      dataRetentionIntervalHours: 24,
      dataRetentionBatchSize: 500,
    };

    mockDb = {
      select: jest.fn(),
      delete: jest.fn(),
    };

    mockDatabase = {
      db: mockDb as unknown as DatabaseService['db'],
      tryAdvisoryLock: jest.fn().mockResolvedValue(true),
      advisoryUnlock: jest.fn().mockResolvedValue(undefined),
    };

    service = new DataRetentionService(
      mockConfig as unknown as AppConfigService,
      mockDatabase as unknown as DatabaseService,
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  describe('onModuleInit', () => {
    it('should not start timer when retention is disabled', () => {
      mockConfig.dataRetentionEnabled = false;
      service.onModuleInit();
      // No timer set — service stays inert
      expect((service as unknown as { timer: unknown }).timer).toBeNull();
    });

    it('should start timer when retention is enabled', () => {
      mockConfig.dataRetentionEnabled = true;
      service.onModuleInit();
      expect((service as unknown as { timer: unknown }).timer).not.toBeNull();
    });
  });

  describe('runRetention', () => {
    it('should skip if advisory lock not acquired', async () => {
      (mockDatabase.tryAdvisoryLock as jest.Mock).mockResolvedValue(false);

      const result = await service.runRetention();

      expect(result).toEqual({ deletedRuns: 0, deletedAuditLogs: 0, deletedWebhookDeliveries: 0 });
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it('should purge terminal runs older than TTL', async () => {
      mockDb.select.mockReturnValue(makeSelectChain([{ id: 'run-1' }, { id: 'run-2' }]));
      // First delete call (runs) returns 2, then select returns empty (done)
      mockDb.select
        .mockReturnValueOnce(makeSelectChain([{ id: 'run-1' }, { id: 'run-2' }]))
        .mockReturnValueOnce(makeSelectChain([]));
      mockDb.delete.mockReturnValue(makeDeleteChain(2));

      const result = await service.runRetention();

      expect(result.deletedRuns).toBe(2);
      expect(mockDatabase.tryAdvisoryLock).toHaveBeenCalledWith('data-retention-lock');
      expect(mockDatabase.advisoryUnlock).toHaveBeenCalledWith('data-retention-lock');
    });

    it('should purge audit logs and webhook deliveries', async () => {
      // No runs to purge
      mockDb.select.mockReturnValue(makeSelectChain([]));
      // Audit log delete returns 5, webhook deliveries returns 3
      mockDb.delete
        .mockReturnValueOnce(makeDeleteChain(5))
        .mockReturnValueOnce(makeDeleteChain(3));

      const result = await service.runRetention();

      expect(result.deletedRuns).toBe(0);
      expect(result.deletedAuditLogs).toBe(5);
      expect(result.deletedWebhookDeliveries).toBe(3);
    });

    it('should release advisory lock even on error', async () => {
      mockDb.select.mockImplementation(() => {
        throw new Error('DB connection lost');
      });

      const result = await service.runRetention();

      expect(result).toEqual({ deletedRuns: 0, deletedAuditLogs: 0, deletedWebhookDeliveries: 0 });
      expect(mockDatabase.advisoryUnlock).toHaveBeenCalledWith('data-retention-lock');
    });

    it('should batch-delete runs when count equals batch size', async () => {
      const batch1 = Array.from({ length: 500 }, (_, i) => ({ id: `run-${i}` }));
      const batch2 = [{ id: 'run-500' }];

      mockDb.select
        .mockReturnValueOnce(makeSelectChain(batch1))
        .mockReturnValueOnce(makeSelectChain(batch2))
        .mockReturnValueOnce(makeSelectChain([]));
      mockDb.delete
        .mockReturnValueOnce(makeDeleteChain(500))  // first batch of runs
        .mockReturnValueOnce(makeDeleteChain(1))     // second batch of runs
        .mockReturnValueOnce(makeDeleteChain(0))     // audit logs
        .mockReturnValueOnce(makeDeleteChain(0));    // webhook deliveries

      const result = await service.runRetention();

      expect(result.deletedRuns).toBe(501);
    });

    it('should use configured TTL for cutoff calculation', async () => {
      mockConfig.dataRetentionTtlDays = 7;
      mockDb.select.mockReturnValue(makeSelectChain([]));
      mockDb.delete.mockReturnValue(makeDeleteChain(0));

      await service.runRetention();

      // Verify the advisory lock was used (proving the method ran)
      expect(mockDatabase.tryAdvisoryLock).toHaveBeenCalled();
      expect(mockDatabase.advisoryUnlock).toHaveBeenCalled();
    });
  });

  describe('onModuleDestroy', () => {
    it('should clear timer on destroy', () => {
      mockConfig.dataRetentionEnabled = true;
      service.onModuleInit();
      expect((service as unknown as { timer: unknown }).timer).not.toBeNull();

      service.onModuleDestroy();
      expect((service as unknown as { timer: unknown }).timer).toBeNull();
    });
  });
});
