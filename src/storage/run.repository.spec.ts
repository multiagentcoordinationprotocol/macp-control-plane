import { ConflictException, NotFoundException } from '@nestjs/common';
import { RunRepository } from './run.repository';
import { RunStatus } from '../contracts/control-plane';
import { DatabaseService } from '../db/database.service';

// ---------------------------------------------------------------------------
// Helpers: build a mock Drizzle fluent-API chain
// ---------------------------------------------------------------------------
function makeMockDb() {
  const insertValues = jest.fn().mockResolvedValue(undefined);
  const insertFn = jest.fn().mockReturnValue({ values: insertValues });

  const selectLimit = jest.fn().mockResolvedValue([]);
  const selectWhere = jest.fn().mockReturnValue({ limit: selectLimit });
  const selectFrom = jest.fn().mockReturnValue({ where: selectWhere });
  const selectFn = jest.fn().mockReturnValue({ from: selectFrom });

  const updateReturning = jest.fn().mockResolvedValue([]);
  const updateWhere = jest.fn().mockReturnValue({ returning: updateReturning });
  const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
  const updateFn = jest.fn().mockReturnValue({ set: updateSet });

  const executeFn = jest.fn().mockResolvedValue({ rows: [] });

  return {
    insert: insertFn,
    select: selectFn,
    update: updateFn,
    execute: executeFn,
    // Expose inner mocks for assertions
    _insert: { values: insertValues },
    _select: { from: selectFrom, where: selectWhere, limit: selectLimit },
    _update: { set: updateSet, where: updateWhere, returning: updateReturning }
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('RunRepository', () => {
  let repo: RunRepository;
  let mockDb: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    mockDb = makeMockDb();
    const databaseService = { db: mockDb } as unknown as DatabaseService;
    repo = new RunRepository(databaseService);
  });

  // ------ create ------
  describe('create', () => {
    it('inserts a run record and returns it via findByIdOrThrow', async () => {
      const fakeRun = {
        id: 'run-1',
        status: 'queued',
        mode: 'live',
        runtimeKind: 'rust'
      };

      // After insert, findByIdOrThrow is called which does select
      mockDb._select.limit.mockResolvedValue([fakeRun]);

      const result = await repo.create({
        status: 'queued',
        mode: 'live',
        runtimeKind: 'rust'
      });

      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb._insert.values).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'queued',
          mode: 'live',
          runtimeKind: 'rust'
        })
      );
      expect(result).toEqual(fakeRun);
    });
  });

  // ------ findById ------
  describe('findById', () => {
    it('returns null when no row is found', async () => {
      mockDb._select.limit.mockResolvedValue([]);

      const result = await repo.findById('nonexistent');

      expect(result).toBeNull();
    });

    it('returns the run when found', async () => {
      const fakeRun = { id: 'run-1', status: 'queued' };
      mockDb._select.limit.mockResolvedValue([fakeRun]);

      const result = await repo.findById('run-1');

      expect(result).toEqual(fakeRun);
    });
  });

  // ------ findByIdOrThrow ------
  describe('findByIdOrThrow', () => {
    it('throws NotFoundException when the run is not found', async () => {
      mockDb._select.limit.mockResolvedValue([]);

      await expect(repo.findByIdOrThrow('missing-id')).rejects.toThrow(NotFoundException);
      await expect(repo.findByIdOrThrow('missing-id')).rejects.toThrow(
        'run missing-id not found'
      );
    });

    it('returns the run when found', async () => {
      const fakeRun = { id: 'run-1', status: 'queued' };
      mockDb._select.limit.mockResolvedValue([fakeRun]);

      const result = await repo.findByIdOrThrow('run-1');
      expect(result).toEqual(fakeRun);
    });
  });

  // ------ findByIdempotencyKey ------
  describe('findByIdempotencyKey', () => {
    it('returns null when not found', async () => {
      mockDb._select.limit.mockResolvedValue([]);

      const result = await repo.findByIdempotencyKey('key-1');
      expect(result).toBeNull();
    });
  });

  // ------ markStarted ------
  describe('markStarted', () => {
    it('transitions to starting status', async () => {
      const fakeRun = { id: 'run-1', status: 'starting' };
      mockDb._update.returning.mockResolvedValue([fakeRun]);

      const result = await repo.markStarted('run-1');

      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb._update.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'starting' })
      );
      expect(result).toEqual(fakeRun);
    });
  });

  // ------ markCompleted ------
  describe('markCompleted', () => {
    it('transitions to completed status', async () => {
      const fakeRun = { id: 'run-1', status: 'completed' };
      mockDb._update.returning.mockResolvedValue([fakeRun]);

      const result = await repo.markCompleted('run-1');

      expect(mockDb._update.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed' })
      );
      expect(result).toEqual(fakeRun);
    });
  });

  // ------ markFailed ------
  describe('markFailed', () => {
    it('transitions to failed status with error details', async () => {
      const fakeRun = { id: 'run-1', status: 'failed' };
      mockDb._update.returning.mockResolvedValue([fakeRun]);

      const result = await repo.markFailed('run-1', 'ERR_TIMEOUT', 'timed out');

      expect(mockDb._update.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          errorCode: 'ERR_TIMEOUT',
          errorMessage: 'timed out'
        })
      );
      expect(result).toEqual(fakeRun);
    });
  });

  // ------ markCancelled ------
  describe('markCancelled', () => {
    it('transitions to cancelled status', async () => {
      const fakeRun = { id: 'run-1', status: 'cancelled' };
      mockDb._update.returning.mockResolvedValue([fakeRun]);

      const result = await repo.markCancelled('run-1');

      expect(mockDb._update.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'cancelled' })
      );
      expect(result).toEqual(fakeRun);
    });
  });

  // ------ markBindingSession ------
  describe('markBindingSession', () => {
    it('transitions to binding_session status with runtimeSessionId', async () => {
      const fakeRun = { id: 'run-1', status: 'binding_session', runtimeSessionId: 'session-abc' };
      mockDb._update.returning.mockResolvedValue([fakeRun]);

      const result = await repo.markBindingSession('run-1', 'session-abc');

      expect(mockDb._update.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'binding_session', runtimeSessionId: 'session-abc' })
      );
      expect(result).toEqual(fakeRun);
    });

    it('throws ConflictException when transitioning from completed to binding_session', async () => {
      mockDb._update.returning.mockResolvedValue([]);
      mockDb._select.limit.mockResolvedValue([{ id: 'run-1', status: 'completed' }]);

      await expect(repo.markBindingSession('run-1', 'session-abc')).rejects.toThrow(ConflictException);
    });
  });

  // ------ invalid transition ------
  describe('transitionTo (invalid transition)', () => {
    it('throws ConflictException when transitioning from completed to running', async () => {
      // Simulate: update returns 0 rows (no valid source state matched)
      mockDb._update.returning.mockResolvedValue([]);
      // findById then returns a run that is already "completed"
      mockDb._select.limit.mockResolvedValue([
        { id: 'run-1', status: 'completed' }
      ]);

      await expect(repo.markRunning('run-1')).rejects.toThrow(ConflictException);
      await expect(repo.markRunning('run-1')).rejects.toThrow(
        /cannot transition run run-1 from 'completed' to 'running'/
      );
    });

    it('throws Error when run not found during transition', async () => {
      mockDb._update.returning.mockResolvedValue([]);
      mockDb._select.limit.mockResolvedValue([]);

      await expect(repo.markStarted('missing-id')).rejects.toThrow(
        'run missing-id not found'
      );
    });

    it('returns existing run when already in target status', async () => {
      const fakeRun = { id: 'run-1', status: 'completed' };
      mockDb._update.returning.mockResolvedValue([]);
      mockDb._select.limit.mockResolvedValue([fakeRun]);

      const result = await repo.markCompleted('run-1');
      expect(result).toEqual(fakeRun);
    });
  });

  // ------ buildListConditions (via listCount) ------
  describe('buildListConditions', () => {
    function mockSelect(count: number) {
      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ count }])
        })
      };
      // listCount uses db.select().from().where() — add select to the mock
      Object.assign(mockDb, { select: jest.fn().mockReturnValue(selectChain) });
      return selectChain;
    }

    it('builds conditions for environment filter', async () => {
      const chain = mockSelect(5);
      const count = await repo.listCount({ environment: 'production' });
      expect(count).toBe(5);
      expect(chain.from).toHaveBeenCalled();
    });

    it('builds conditions for scenarioRef filter', async () => {
      mockSelect(3);
      const count = await repo.listCount({ scenarioRef: 'fraud-detection' });
      expect(count).toBe(3);
    });

    it('builds conditions for search filter', async () => {
      mockSelect(2);
      const count = await repo.listCount({ search: 'agent-123' });
      expect(count).toBe(2);
    });

    it('builds conditions for combined filters', async () => {
      mockSelect(1);
      const count = await repo.listCount({
        status: 'completed' as RunStatus,
        environment: 'staging',
        scenarioRef: 'decision',
        search: 'test'
      });
      expect(count).toBe(1);
    });
  });

  // ------ allocateSequence ------
  describe('allocateSequence', () => {
    it('returns the starting sequence number', async () => {
      mockDb.execute.mockResolvedValue({
        rows: [{ last_event_seq: 5 }]
      });

      const seq = await repo.allocateSequence('run-1', 3);

      expect(mockDb.execute).toHaveBeenCalled();
      // last_event_seq=5, count=3 => start = 5 - 3 + 1 = 3
      expect(seq).toBe(3);
    });

    it('throws when run not found', async () => {
      mockDb.execute.mockResolvedValue({ rows: [] });

      await expect(repo.allocateSequence('missing-id')).rejects.toThrow(
        'run missing-id not found while allocating sequence'
      );
    });
  });
});
