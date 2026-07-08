import { WebhookDeliveryRepository } from './webhook-delivery.repository';
import { DatabaseService } from '../db/database.service';

// ---------------------------------------------------------------------------
// Helpers: build a mock Drizzle fluent-API chain
// ---------------------------------------------------------------------------
function makeMockDb() {
  const insertValues = jest.fn().mockResolvedValue(undefined);
  const insertFn = jest.fn().mockReturnValue({ values: insertValues });

  const updateWhere = jest.fn().mockResolvedValue(undefined);
  const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
  const updateFn = jest.fn().mockReturnValue({ set: updateSet });

  const selectWhere = jest.fn().mockResolvedValue([]);
  const selectFrom = jest.fn().mockReturnValue({ where: selectWhere });
  const selectFn = jest.fn().mockReturnValue({ from: selectFrom });

  return {
    insert: insertFn,
    update: updateFn,
    select: selectFn,
    // Expose inner mocks for assertions
    _insert: { values: insertValues },
    _update: { set: updateSet, where: updateWhere },
    _select: { from: selectFrom, where: selectWhere }
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('WebhookDeliveryRepository', () => {
  let repo: WebhookDeliveryRepository;
  let mockDb: ReturnType<typeof makeMockDb>;

  beforeEach(() => {
    mockDb = makeMockDb();
    const databaseService = { db: mockDb } as unknown as DatabaseService;
    repo = new WebhookDeliveryRepository(databaseService);
  });

  // ------ create ------
  describe('create', () => {
    it('inserts a delivery with status pending and attempts 0', async () => {
      const input = {
        webhookId: 'wh-1',
        event: 'run.completed',
        runId: 'run-1',
        payload: { runId: 'run-1', status: 'completed' }
      };

      const result = await repo.create(input);

      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockDb._insert.values).toHaveBeenCalledWith(
        expect.objectContaining({
          webhookId: 'wh-1',
          event: 'run.completed',
          runId: 'run-1',
          payload: input.payload,
          status: 'pending',
          attempts: 0,
          id: expect.any(String),
          createdAt: expect.any(String)
        })
      );
      expect(result).toEqual(
        expect.objectContaining({
          ...input,
          status: 'pending',
          attempts: 0,
          id: expect.any(String),
          createdAt: expect.any(String)
        })
      );
    });
  });

  // ------ markDelivered ------
  describe('markDelivered', () => {
    it('sets status delivered with attempts and deliveredAt', async () => {
      await repo.markDelivered('delivery-1', 200);

      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb._update.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'delivered',
          responseStatus: 200,
          attempts: 1,
          deliveredAt: expect.any(String),
          lastAttemptAt: expect.any(String)
        })
      );
      expect(mockDb._update.where).toHaveBeenCalled();
    });
  });

  // ------ markFailed ------
  describe('markFailed', () => {
    it('keeps status pending on attempt 1', async () => {
      await repo.markFailed('delivery-1', 1, 'connection refused');

      expect(mockDb._update.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'pending',
          attempts: 1,
          errorMessage: 'connection refused',
          lastAttemptAt: expect.any(String)
        })
      );
    });

    it('keeps status pending on attempt 2', async () => {
      await repo.markFailed('delivery-1', 2, 'HTTP 503', 503);

      expect(mockDb._update.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'pending',
          attempts: 2,
          errorMessage: 'HTTP 503',
          responseStatus: 503
        })
      );
    });

    it('flips status to failed on attempt 3', async () => {
      await repo.markFailed('delivery-1', 3, 'HTTP 500', 500);

      expect(mockDb._update.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          attempts: 3,
          errorMessage: 'HTTP 500',
          responseStatus: 500
        })
      );
    });
  });

  // ------ listPending ------
  describe('listPending', () => {
    it('selects deliveries filtered to status=pending', async () => {
      const pending = [
        { id: 'd1', status: 'pending', attempts: 0 },
        { id: 'd2', status: 'pending', attempts: 2 }
      ];
      mockDb._select.where.mockResolvedValue(pending);

      const result = await repo.listPending();

      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb._select.from).toHaveBeenCalled();
      expect(mockDb._select.where).toHaveBeenCalledTimes(1);
      expect(result).toEqual(pending);
    });
  });

  // ------ listByWebhookId ------
  describe('listByWebhookId', () => {
    it('selects deliveries for a webhook id', async () => {
      const rows = [{ id: 'd1', webhookId: 'wh-1' }];
      mockDb._select.where.mockResolvedValue(rows);

      const result = await repo.listByWebhookId('wh-1');

      expect(mockDb._select.where).toHaveBeenCalledTimes(1);
      expect(result).toEqual(rows);
    });
  });
});
