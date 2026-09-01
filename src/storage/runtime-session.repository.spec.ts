import { RuntimeSessionRepository } from './runtime-session.repository';
import { DatabaseService } from '../db/database.service';

// ---------------------------------------------------------------------------
// Helpers: flatten a drizzle `SQL` fragment (from a `sql\`...\`` template) into
// a plain string with `?` placeholders for params, plus the collected params,
// so tests can assert on the *shape* of the generated expression without a
// real Postgres connection.
// ---------------------------------------------------------------------------
function flattenSql(node: unknown): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  const parts: string[] = [];

  const visit = (n: any) => {
    if (n && Array.isArray(n.queryChunks)) {
      for (const chunk of n.queryChunks) visit(chunk);
    } else if (n && Array.isArray(n.value)) {
      parts.push(n.value.join(''));
    } else if (typeof n === 'string') {
      parts.push(n);
    } else if (n && typeof n === 'object' && 'name' in n && n.table) {
      // A drizzle Column reference used directly inside `sql\`...\``.
      parts.push(String(n.name));
    } else {
      params.push(n);
      parts.push('?');
    }
  };
  visit(node);
  return { text: parts.join(''), params };
}

// ---------------------------------------------------------------------------
// Mock DB builder
// ---------------------------------------------------------------------------
function makeMockDb() {
  const updateWhere = jest.fn().mockResolvedValue(undefined);
  const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
  const updateFn = jest.fn().mockReturnValue({ set: updateSet });

  const selectLimit = jest.fn().mockResolvedValue([]);
  const selectWhere = jest.fn().mockReturnValue({ limit: selectLimit });
  const selectFrom = jest.fn().mockReturnValue({ where: selectWhere });
  const selectFn = jest.fn().mockReturnValue({ from: selectFrom });

  return {
    update: updateFn,
    select: selectFn,
    _update: { set: updateSet, where: updateWhere }
  };
}

describe('RuntimeSessionRepository', () => {
  let repo: RuntimeSessionRepository;
  let mockDb: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    mockDb = makeMockDb();
    const databaseService = { db: mockDb } as unknown as DatabaseService;
    repo = new RuntimeSessionRepository(databaseService);
  });

  describe('updateStreamCursor', () => {
    it('writes lastStreamCursor as a single GREATEST(COALESCE(current, 0), new) UPDATE — no read-then-write', async () => {
      await repo.updateStreamCursor('run-1', 42, 7);

      expect(mockDb.update).toHaveBeenCalledTimes(1);
      expect(mockDb._update.set).toHaveBeenCalledTimes(1);
      // Exactly one UPDATE call — no preceding SELECT for the current value.
      expect(mockDb.select).not.toHaveBeenCalled();

      const setArg = mockDb._update.set.mock.calls[0][0];
      const cursorSql = flattenSql(setArg.lastStreamCursor);
      expect(cursorSql.text).toContain('GREATEST');
      expect(cursorSql.text).toContain('COALESCE');
      expect(cursorSql.text).toContain('last_stream_cursor');
      expect(cursorSql.params).toContain(42);

      const ordinalSql = flattenSql(setArg.lastEnvelopeOrdinal);
      expect(ordinalSql.text).toContain('GREATEST');
      expect(ordinalSql.text).toContain('last_envelope_ordinal');
      expect(ordinalSql.params).toContain(7);
    });

    it('omits lastEnvelopeOrdinal from the SET clause when no ordinal is passed (preserves "ordinal is optional")', async () => {
      await repo.updateStreamCursor('run-1', 42);

      const setArg = mockDb._update.set.mock.calls[0][0];
      expect(setArg).not.toHaveProperty('lastEnvelopeOrdinal');
      // lastStreamCursor is still written as a monotonic floor even when the
      // ordinal is omitted.
      const cursorSql = flattenSql(setArg.lastStreamCursor);
      expect(cursorSql.text).toContain('GREATEST');
      expect(cursorSql.params).toContain(42);
    });

    it('never lowers a stored value: the expression floors on the CURRENT column, not a value read beforehand', async () => {
      // This is the structural guarantee behind "never clobbers": both SET
      // expressions reference the table's own current column value inside
      // GREATEST(...) rather than assigning a bare literal, so even if a
      // caller (e.g. an unseeded recovery marker) passes a stale/low value,
      // SQL — not application code — enforces the floor.
      await repo.updateStreamCursor('run-1', 0, 0);

      const setArg = mockDb._update.set.mock.calls[0][0];
      const cursorSql = flattenSql(setArg.lastStreamCursor);
      const ordinalSql = flattenSql(setArg.lastEnvelopeOrdinal);

      // The column names appear *inside* the GREATEST(...) expression itself
      // (not merely as a bare assignment), proving the write is a floor.
      expect(cursorSql.text).toMatch(/GREATEST\(COALESCE\(.*last_stream_cursor.*,\s*0\),\s*\?\)/);
      expect(ordinalSql.text).toMatch(/GREATEST\(.*last_envelope_ordinal.*,\s*\?\)/);
    });

    it('scopes the update to the given runId', async () => {
      await repo.updateStreamCursor('run-42', 1, 1);
      expect(mockDb._update.where).toHaveBeenCalled();
    });
  });
});
