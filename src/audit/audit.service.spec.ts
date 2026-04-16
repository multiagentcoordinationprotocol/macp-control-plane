import { AuditService, AuditEntry } from './audit.service';
import { DatabaseService } from '../db/database.service';

describe('AuditService', () => {
  let service: AuditService;
  let mockInsert: jest.Mock;
  let mockValues: jest.Mock;
  let mockSelect: jest.Mock;
  let mockFrom: jest.Mock;
  let mockWhere: jest.Mock;
  let mockOrderBy: jest.Mock;
  let mockLimit: jest.Mock;
  let mockOffset: jest.Mock;
  let mockDatabase: { db: Record<string, jest.Mock> };

  const baseEntry: AuditEntry = {
    actor: 'user-1',
    actorType: 'user',
    action: 'run.create',
    resource: 'run',
    resourceId: 'run-123',
    details: { mode: 'decision' },
    requestId: 'req-abc',
  };

  beforeEach(() => {
    mockValues = jest.fn().mockResolvedValue(undefined);
    mockInsert = jest.fn().mockReturnValue({ values: mockValues });

    mockOffset = jest.fn().mockResolvedValue([]);
    mockLimit = jest.fn().mockReturnValue({ offset: mockOffset });
    mockOrderBy = jest.fn().mockReturnValue({ limit: mockLimit });
    mockWhere = jest.fn().mockReturnValue({ orderBy: mockOrderBy });
    mockFrom = jest.fn().mockReturnValue({ where: mockWhere });
    mockSelect = jest.fn().mockReturnValue({ from: mockFrom });

    mockDatabase = {
      db: {
        insert: mockInsert,
        select: mockSelect,
      },
    };
    service = new AuditService(mockDatabase as unknown as DatabaseService);
  });

  describe('record', () => {
    it('inserts an audit entry into the database', async () => {
      await service.record(baseEntry);

      expect(mockInsert).toHaveBeenCalledTimes(1);
      expect(mockValues).toHaveBeenCalledTimes(1);

      const insertedValues = mockValues.mock.calls[0][0];
      expect(insertedValues.actor).toBe('user-1');
      expect(insertedValues.actorType).toBe('user');
      expect(insertedValues.action).toBe('run.create');
      expect(insertedValues.resource).toBe('run');
      expect(insertedValues.resourceId).toBe('run-123');
      expect(insertedValues.details).toEqual({ mode: 'decision' });
      expect(insertedValues.requestId).toBe('req-abc');
      expect(insertedValues.id).toBeDefined();
      expect(insertedValues.createdAt).toBeDefined();
    });

    it('defaults details to empty object when not provided', async () => {
      const entry: AuditEntry = {
        actor: 'system',
        actorType: 'system',
        action: 'circuit_breaker.reset',
        resource: 'circuit_breaker',
      };

      await service.record(entry);

      const insertedValues = mockValues.mock.calls[0][0];
      expect(insertedValues.details).toEqual({});
    });

    it('swallows database errors without throwing', async () => {
      mockValues.mockRejectedValue(new Error('connection lost'));

      // Should NOT throw
      await expect(service.record(baseEntry)).resolves.toBeUndefined();
    });

    it('swallows non-Error exceptions without throwing', async () => {
      mockValues.mockRejectedValue('string error');

      await expect(service.record(baseEntry)).resolves.toBeUndefined();
    });
  });

  describe('list', () => {
    it('returns data and total from the database', async () => {
      const fakeRows = [
        { id: 'a1', actor: 'user-1', action: 'run.create', createdAt: '2026-01-01T00:00:00Z' },
      ];
      // First select call returns data rows
      mockOffset.mockResolvedValueOnce(fakeRows);
      // Second select call (count) — needs its own chain
      const countWhere = jest.fn().mockResolvedValue([{ count: 42 }]);
      const countFrom = jest.fn().mockReturnValue({ where: countWhere });

      // Promise.all calls select twice: once for data, once for count
      mockSelect
        .mockReturnValueOnce({ from: mockFrom })
        .mockReturnValueOnce({ from: countFrom });

      const result = await service.list({});

      expect(result.data).toEqual(fakeRows);
      expect(result.total).toBe(42);
    });

    it('returns total 0 when count result is empty', async () => {
      mockOffset.mockResolvedValueOnce([]);
      const countWhere = jest.fn().mockResolvedValue([]);
      const countFrom = jest.fn().mockReturnValue({ where: countWhere });

      mockSelect
        .mockReturnValueOnce({ from: mockFrom })
        .mockReturnValueOnce({ from: countFrom });

      const result = await service.list({});

      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('defaults limit to 50 and offset to 0', async () => {
      mockOffset.mockResolvedValueOnce([]);
      const countWhere = jest.fn().mockResolvedValue([{ count: 0 }]);
      const countFrom = jest.fn().mockReturnValue({ where: countWhere });

      mockSelect
        .mockReturnValueOnce({ from: mockFrom })
        .mockReturnValueOnce({ from: countFrom });

      await service.list({});

      expect(mockLimit).toHaveBeenCalledWith(50);
      expect(mockOffset).toHaveBeenCalledWith(0);
    });

    it('applies custom limit and offset', async () => {
      mockOffset.mockResolvedValueOnce([]);
      const countWhere = jest.fn().mockResolvedValue([{ count: 0 }]);
      const countFrom = jest.fn().mockReturnValue({ where: countWhere });

      mockSelect
        .mockReturnValueOnce({ from: mockFrom })
        .mockReturnValueOnce({ from: countFrom });

      await service.list({ limit: 10, offset: 20 });

      expect(mockLimit).toHaveBeenCalledWith(10);
      expect(mockOffset).toHaveBeenCalledWith(20);
    });

    it('passes filter conditions to the where clause', async () => {
      mockOffset.mockResolvedValueOnce([]);
      const countWhere = jest.fn().mockResolvedValue([{ count: 0 }]);
      const countFrom = jest.fn().mockReturnValue({ where: countWhere });

      mockSelect
        .mockReturnValueOnce({ from: mockFrom })
        .mockReturnValueOnce({ from: countFrom });

      await service.list({ actor: 'user-1', action: 'run.create' });

      // where should be called with a composed condition (not undefined)
      expect(mockWhere).toHaveBeenCalled();
      const whereArg = mockWhere.mock.calls[0][0];
      expect(whereArg).toBeDefined();
    });
  });
});
