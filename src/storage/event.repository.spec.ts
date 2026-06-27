import { EventRepository } from './event.repository';
import { DatabaseService } from '../db/database.service';
import { CanonicalEvent } from '../contracts/control-plane';
import { RawRuntimeEvent } from '../contracts/runtime';

// ---------------------------------------------------------------------------
// Mock DB builder
// ---------------------------------------------------------------------------
function makeMockDb() {
  const onConflictDoNothing = jest.fn().mockResolvedValue(undefined);
  const insertValues = jest.fn().mockReturnValue({ onConflictDoNothing });
  const insertFn = jest.fn().mockReturnValue({ values: insertValues });

  const selectLimit = jest.fn().mockResolvedValue([]);
  const selectOrderBy = jest.fn().mockReturnValue({ limit: selectLimit });
  const selectWhere = jest.fn().mockReturnValue({ orderBy: selectOrderBy, limit: selectLimit });
  const selectFrom = jest.fn().mockReturnValue({ where: selectWhere });
  const selectFn = jest.fn().mockReturnValue({ from: selectFrom });

  return {
    insert: insertFn,
    select: selectFn,
    _insert: { values: insertValues, onConflictDoNothing },
    _select: { from: selectFrom, where: selectWhere, orderBy: selectOrderBy, limit: selectLimit }
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('EventRepository', () => {
  let repo: EventRepository;
  let mockDb: ReturnType<typeof makeMockDb>;
  let databaseService: DatabaseService;

  beforeEach(() => {
    mockDb = makeMockDb();
    databaseService = { db: mockDb } as unknown as DatabaseService;
    repo = new EventRepository(databaseService);
  });

  // ------ appendRaw ------
  describe('appendRaw', () => {
    it('calls insert with correct values', async () => {
      const raw: RawRuntimeEvent = {
        kind: 'stream-envelope',
        receivedAt: '2026-01-01T00:00:00Z'
      };

      await repo.appendRaw('run-1', 1, raw);

      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb._insert.values).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-1',
          seq: 1,
          ts: '2026-01-01T00:00:00Z',
          kind: 'stream-envelope',
          sourceName: 'rust-runtime'
        })
      );
    });

    it('uses provided transaction when tx is given', async () => {
      const txOnConflict = jest.fn().mockResolvedValue(undefined);
      const txInsertValues = jest.fn().mockReturnValue({ onConflictDoNothing: txOnConflict });
      const txInsert = jest.fn().mockReturnValue({ values: txInsertValues });
      const tx = { insert: txInsert } as any;

      const raw: RawRuntimeEvent = {
        kind: 'send-ack',
        receivedAt: '2026-01-01T00:00:00Z'
      };

      await repo.appendRaw('run-1', 2, raw, tx);

      // Should use tx.insert, NOT the default db.insert
      expect(txInsert).toHaveBeenCalled();
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  // ------ appendCanonical ------
  describe('appendCanonical', () => {
    it('returns immediately for empty array', async () => {
      await repo.appendCanonical([]);

      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it('calls insert with mapped events', async () => {
      const events: CanonicalEvent[] = [
        {
          id: 'evt-1',
          runId: 'run-1',
          seq: 1,
          ts: '2026-01-01T00:00:00Z',
          type: 'run.created',
          source: { kind: 'macp-control-plane', name: 'macp-control-plane' },
          data: { foo: 'bar' }
        }
      ];

      await repo.appendCanonical(events);

      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb._insert.values).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'evt-1',
            runId: 'run-1',
            seq: 1,
            type: 'run.created',
            sourceKind: 'macp-control-plane',
            sourceName: 'macp-control-plane'
          })
        ])
      );
    });

    it('uses onConflictDoNothing for deduplication', async () => {
      const events: CanonicalEvent[] = [
        {
          id: 'evt-1',
          runId: 'run-1',
          seq: 1,
          ts: '2026-01-01T00:00:00Z',
          type: 'run.started',
          source: { kind: 'macp-control-plane', name: 'macp-control-plane' },
          data: {}
        }
      ];

      await repo.appendCanonical(events);

      expect(mockDb._insert.onConflictDoNothing).toHaveBeenCalled();
    });

    it('uses provided transaction when tx is given', async () => {
      const txOnConflict = jest.fn().mockResolvedValue(undefined);
      const txInsertValues = jest.fn().mockReturnValue({ onConflictDoNothing: txOnConflict });
      const txInsert = jest.fn().mockReturnValue({ values: txInsertValues });
      const tx = { insert: txInsert } as any;

      const events: CanonicalEvent[] = [
        {
          id: 'evt-2',
          runId: 'run-1',
          seq: 2,
          ts: '2026-01-01T00:00:00Z',
          type: 'message.sent',
          source: { kind: 'runtime', name: 'rust-runtime' },
          data: { text: 'hello' }
        }
      ];

      await repo.appendCanonical(events, tx);

      expect(txInsert).toHaveBeenCalled();
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  // ------ listCanonicalByRun ------
  describe('listCanonicalByRun', () => {
    it('queries with the provided runId and defaults', async () => {
      const fakeEvents = [{ id: 'evt-1', seq: 1 }];
      mockDb._select.limit.mockResolvedValue(fakeEvents);

      const result = await repo.listCanonicalByRun('run-1');

      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb._select.from).toHaveBeenCalled();
      expect(mockDb._select.where).toHaveBeenCalled();
      expect(result).toEqual(fakeEvents);
    });
  });

  // ------ listCanonicalRange ------
  describe('listCanonicalRange', () => {
    it('queries with runId, afterSeq, toSeq and limit', async () => {
      const fakeEvents = [{ id: 'evt-1', seq: 3 }];
      mockDb._select.limit.mockResolvedValue(fakeEvents);

      const result = await repo.listCanonicalRange('run-1', 2, 10, 100);

      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb._select.from).toHaveBeenCalled();
      expect(mockDb._select.where).toHaveBeenCalled();
      expect(result).toEqual(fakeEvents);
    });

    it('uses default limit of 500', async () => {
      mockDb._select.limit.mockResolvedValue([]);

      await repo.listCanonicalRange('run-1', 0, 100);

      expect(mockDb._select.limit).toHaveBeenCalledWith(500);
    });
  });

  // ------ listRawByRun ------
  describe('listRawByRun', () => {
    it('queries raw events by runId with afterSeq', async () => {
      const fakeEvents = [{ id: 'raw-1', seq: 1 }];
      mockDb._select.limit.mockResolvedValue(fakeEvents);

      const result = await repo.listRawByRun('run-1', 0, 500);

      expect(mockDb.select).toHaveBeenCalled();
      expect(result).toEqual(fakeEvents);
    });

    it('uses default afterSeq of 0 and limit of 1000', async () => {
      mockDb._select.limit.mockResolvedValue([]);

      await repo.listRawByRun('run-1');

      expect(mockDb._select.limit).toHaveBeenCalledWith(1000);
    });
  });

  // ------ listCanonicalUpTo ------
  describe('listCanonicalUpTo', () => {
    it('queries without upper bound when seq is undefined', async () => {
      const fakeEvents = [{ id: 'evt-1', seq: 1 }];
      // listCanonicalUpTo chains: select().from().where().orderBy()
      mockDb._select.orderBy.mockResolvedValue(fakeEvents);

      const result = await repo.listCanonicalUpTo('run-1');

      expect(mockDb.select).toHaveBeenCalled();
      expect(result).toEqual(fakeEvents);
    });

    it('queries with upper bound when seq is provided', async () => {
      const fakeEvents = [{ id: 'evt-1', seq: 1 }];
      mockDb._select.orderBy.mockResolvedValue(fakeEvents);

      const result = await repo.listCanonicalUpTo('run-1', 5);

      expect(mockDb.select).toHaveBeenCalled();
      expect(result).toEqual(fakeEvents);
    });
  });
});
