import { ProjectionRepository } from './projection.repository';
import { DatabaseService } from '../db/database.service';
import { RunStateProjection } from '../contracts/control-plane';

// ---------------------------------------------------------------------------
// Helpers: build a mock Drizzle fluent-API chain
// ---------------------------------------------------------------------------
function makeMockDb() {
  const onConflictDoUpdate = jest.fn().mockResolvedValue(undefined);
  const insertValues = jest.fn().mockReturnValue({ onConflictDoUpdate });
  const insertFn = jest.fn().mockReturnValue({ values: insertValues });

  const selectLimit = jest.fn().mockResolvedValue([]);
  const selectWhere = jest.fn().mockReturnValue({ limit: selectLimit });
  const selectFrom = jest.fn().mockReturnValue({ where: selectWhere });
  const selectFn = jest.fn().mockReturnValue({ from: selectFrom });

  return {
    insert: insertFn,
    select: selectFn,
    // Expose inner mocks for assertions
    _insert: { values: insertValues, onConflictDoUpdate },
    _select: { from: selectFrom, where: selectWhere, limit: selectLimit }
  };
}

// ---------------------------------------------------------------------------
// Fake projection used across tests
// ---------------------------------------------------------------------------
function fakeProjection(): RunStateProjection {
  return {
    run: { id: 'run-1', status: 'running' },
    participants: [{ id: 'agent-1', name: 'Agent 1' }],
    graph: { nodes: [], edges: [] },
    decision: { current: null },
    signals: { items: [] },
    timeline: { entries: [] },
    trace: { spans: [] },
    progress: { percent: 50 }
  } as unknown as RunStateProjection;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('ProjectionRepository', () => {
  let repo: ProjectionRepository;
  let mockDb: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    mockDb = makeMockDb();
    const databaseService = { db: mockDb } as unknown as DatabaseService;
    repo = new ProjectionRepository(databaseService);
  });

  // ------ get ------
  describe('get', () => {
    it('returns null when no row is found', async () => {
      mockDb._select.limit.mockResolvedValue([]);

      const result = await repo.get('nonexistent');

      expect(result).toBeNull();
      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb._select.from).toHaveBeenCalled();
      expect(mockDb._select.where).toHaveBeenCalled();
      expect(mockDb._select.limit).toHaveBeenCalledWith(1);
    });

    it('returns the projection row when found', async () => {
      const fakeRow = {
        runId: 'run-1',
        version: 5,
        schemaVersion: 1,
        runSummary: { id: 'run-1' },
        participants: []
      };
      mockDb._select.limit.mockResolvedValue([fakeRow]);

      const result = await repo.get('run-1');

      expect(result).toEqual(fakeRow);
    });
  });

  // ------ upsert ------
  describe('upsert', () => {
    it('inserts with correct values including version and schemaVersion', async () => {
      const projection = fakeProjection();

      await repo.upsert('run-1', projection, 10, 2);

      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb._insert.values).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-1',
          version: 10,
          schemaVersion: 2,
          runSummary: projection.run,
          participants: projection.participants,
          graph: projection.graph,
          decision: projection.decision,
          signals: projection.signals,
          timeline: projection.timeline,
          traceSummary: projection.trace,
          progress: projection.progress
        })
      );
      expect(mockDb._insert.onConflictDoUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          set: expect.objectContaining({
            version: 10,
            schemaVersion: 2
          })
        })
      );
    });

    it('defaults schemaVersion to 0 when not provided', async () => {
      const projection = fakeProjection();

      await repo.upsert('run-1', projection, 3);

      expect(mockDb._insert.values).toHaveBeenCalledWith(
        expect.objectContaining({
          schemaVersion: 0
        })
      );
      expect(mockDb._insert.onConflictDoUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          set: expect.objectContaining({
            schemaVersion: 0
          })
        })
      );
    });

    it('uses tx when provided instead of database.db', async () => {
      const txOnConflict = jest.fn().mockResolvedValue(undefined);
      const txValues = jest.fn().mockReturnValue({ onConflictDoUpdate: txOnConflict });
      const txInsert = jest.fn().mockReturnValue({ values: txValues });
      const txDb = { insert: txInsert } as unknown as any;

      const projection = fakeProjection();

      await repo.upsert('run-1', projection, 1, undefined, txDb);

      // Should use the tx, not the database.db
      expect(txInsert).toHaveBeenCalled();
      expect(txValues).toHaveBeenCalled();
      expect(txOnConflict).toHaveBeenCalled();

      // Should NOT have used the default db
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it('includes setWhere for version guard in onConflictDoUpdate', async () => {
      const projection = fakeProjection();

      await repo.upsert('run-1', projection, 7);

      expect(mockDb._insert.onConflictDoUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          setWhere: expect.anything()
        })
      );

      // Verify the onConflictDoUpdate call has target, set, and setWhere
      const callArgs = mockDb._insert.onConflictDoUpdate.mock.calls[0][0];
      expect(callArgs).toHaveProperty('target');
      expect(callArgs).toHaveProperty('set');
      expect(callArgs).toHaveProperty('setWhere');
    });

    it('includes updatedAt in the upsert data', async () => {
      const projection = fakeProjection();

      await repo.upsert('run-1', projection, 1);

      expect(mockDb._insert.values).toHaveBeenCalledWith(
        expect.objectContaining({
          updatedAt: expect.any(String)
        })
      );
    });
  });
});
