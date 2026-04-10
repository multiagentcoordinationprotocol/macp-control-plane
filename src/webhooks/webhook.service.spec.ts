import { Test, TestingModule } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { WebhookDeliveryRepository } from './webhook-delivery.repository';
import { WebhookRepository } from './webhook.repository';
import { WebhookPayload, WebhookService } from './webhook.service';

describe('WebhookService', () => {
  let service: WebhookService;
  let webhookRepository: jest.Mocked<WebhookRepository>;
  let deliveryRepository: jest.Mocked<WebhookDeliveryRepository>;
  let instrumentation: { webhookDeliveriesTotal: { inc: jest.Mock } };
  let fetchSpy: jest.SpyInstance;

  const samplePayload: WebhookPayload = {
    event: 'run.completed',
    runId: 'run-1',
    status: 'completed',
    timestamp: '2026-04-07T00:00:00.000Z',
    data: { result: 'success' },
  };

  const makeWebhook = (overrides?: Record<string, unknown>) => ({
    id: 'wh-1',
    url: 'https://example.com/hook',
    events: ['run.completed', 'run.failed'],
    secret: 'test-secret',
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });

  const makeDelivery = (overrides?: Record<string, unknown>) => ({
    id: 'del-1',
    webhookId: 'wh-1',
    event: 'run.completed',
    runId: 'run-1',
    payload: samplePayload as unknown as Record<string, unknown>,
    status: 'pending',
    attempts: 0,
    createdAt: '2026-04-07T00:00:00.000Z',
    ...overrides,
  });

  beforeEach(async () => {
    jest.useFakeTimers();

    instrumentation = {
      webhookDeliveriesTotal: { inc: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookService,
        {
          provide: WebhookRepository,
          useValue: {
            create: jest.fn(),
            list: jest.fn(),
            listActive: jest.fn(),
            findById: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
          },
        },
        {
          provide: WebhookDeliveryRepository,
          useValue: {
            create: jest.fn(),
            markDelivered: jest.fn(),
            markFailed: jest.fn(),
            listPending: jest.fn(),
          },
        },
        {
          provide: InstrumentationService,
          useValue: instrumentation,
        },
      ],
    }).compile();

    service = module.get(WebhookService);
    webhookRepository = module.get(WebhookRepository);
    deliveryRepository = module.get(WebhookDeliveryRepository);

    // Mock global fetch
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);
  });

  afterEach(() => {
    jest.useRealTimers();
    fetchSpy.mockRestore();
  });

  // ─── CRUD delegation ───────────────────────────────────────────────

  describe('register', () => {
    it('should delegate to webhookRepository.create', async () => {
      const input = { url: 'https://example.com/hook', events: ['run.completed'], secret: 's3cret' };
      const created = makeWebhook({ id: 'wh-new' });
      webhookRepository.create.mockResolvedValue(created as any);

      const result = await service.register(input);

      expect(webhookRepository.create).toHaveBeenCalledWith(input);
      expect(result).toBe(created);
    });
  });

  describe('list', () => {
    it('should delegate to webhookRepository.list', async () => {
      const hooks = [makeWebhook(), makeWebhook({ id: 'wh-2' })];
      webhookRepository.list.mockResolvedValue(hooks as any);

      const result = await service.list();

      expect(webhookRepository.list).toHaveBeenCalled();
      expect(result).toBe(hooks);
    });
  });

  describe('update', () => {
    it('should delegate to webhookRepository.update', async () => {
      const fields = { url: 'https://updated.example.com', active: false };
      const updated = makeWebhook({ ...fields });
      webhookRepository.update.mockResolvedValue(updated as any);

      const result = await service.update('wh-1', fields);

      expect(webhookRepository.update).toHaveBeenCalledWith('wh-1', fields);
      expect(result).toBe(updated);
    });
  });

  describe('remove', () => {
    it('should delegate to webhookRepository.delete', async () => {
      webhookRepository.delete.mockResolvedValue(undefined);

      await service.remove('wh-1');

      expect(webhookRepository.delete).toHaveBeenCalledWith('wh-1');
    });
  });

  // ─── fireEvent ─────────────────────────────────────────────────────

  describe('fireEvent', () => {
    it('should filter active webhooks by matching event', async () => {
      const matchingHook = makeWebhook({ id: 'wh-match', events: ['run.completed'] });
      const nonMatchingHook = makeWebhook({ id: 'wh-nomatch', events: ['run.failed'] });
      webhookRepository.listActive.mockResolvedValue([matchingHook, nonMatchingHook] as any);
      deliveryRepository.create.mockResolvedValue(makeDelivery() as any);

      await service.fireEvent(samplePayload);

      // Only the matching webhook should get a delivery record
      expect(deliveryRepository.create).toHaveBeenCalledTimes(1);
      expect(deliveryRepository.create).toHaveBeenCalledWith({
        webhookId: 'wh-match',
        event: 'run.completed',
        runId: 'run-1',
        payload: samplePayload as unknown as Record<string, unknown>,
      });
    });

    it('should match webhooks with empty events array (wildcard)', async () => {
      const wildcardHook = makeWebhook({ id: 'wh-wildcard', events: [] });
      webhookRepository.listActive.mockResolvedValue([wildcardHook] as any);
      deliveryRepository.create.mockResolvedValue(makeDelivery({ webhookId: 'wh-wildcard' }) as any);

      await service.fireEvent(samplePayload);

      expect(deliveryRepository.create).toHaveBeenCalledTimes(1);
      expect(deliveryRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ webhookId: 'wh-wildcard' }),
      );
    });

    it('should create delivery records before attempting delivery', async () => {
      const hook = makeWebhook();
      webhookRepository.listActive.mockResolvedValue([hook] as any);
      deliveryRepository.create.mockResolvedValue(makeDelivery() as any);

      const callOrder: string[] = [];
      deliveryRepository.create.mockImplementation(async (_input) => {
        callOrder.push('create-delivery');
        return makeDelivery() as any;
      });
      fetchSpy.mockImplementation(async () => {
        callOrder.push('fetch');
        return { ok: true, status: 200 } as Response;
      });

      await service.fireEvent(samplePayload);

      // Allow the void promise (deliverWithTracking) to settle
      await jest.advanceTimersByTimeAsync(0);

      expect(callOrder[0]).toBe('create-delivery');
      expect(callOrder).toContain('fetch');
    });

    it('should skip webhooks that do not match the event', async () => {
      const nonMatchingHook = makeWebhook({ events: ['run.failed'] });
      webhookRepository.listActive.mockResolvedValue([nonMatchingHook] as any);

      await service.fireEvent(samplePayload);

      expect(deliveryRepository.create).not.toHaveBeenCalled();
    });

    it('should fire delivery for each matching webhook', async () => {
      const hook1 = makeWebhook({ id: 'wh-1' });
      const hook2 = makeWebhook({ id: 'wh-2', events: [] }); // wildcard
      webhookRepository.listActive.mockResolvedValue([hook1, hook2] as any);
      deliveryRepository.create.mockResolvedValue(makeDelivery() as any);

      await service.fireEvent(samplePayload);

      expect(deliveryRepository.create).toHaveBeenCalledTimes(2);
    });
  });

  // ─── deliverWithTracking (exercised via fireEvent) ─────────────────

  describe('deliverWithTracking', () => {
    it('should send correct HMAC-SHA256 signature', async () => {
      const hook = makeWebhook({ secret: 'my-secret' });
      webhookRepository.listActive.mockResolvedValue([hook] as any);
      deliveryRepository.create.mockResolvedValue(makeDelivery() as any);

      await service.fireEvent(samplePayload);
      // Let the async delivery resolve
      await jest.advanceTimersByTimeAsync(0);

      const body = JSON.stringify(samplePayload);
      const expectedSignature = createHmac('sha256', 'my-secret').update(body).digest('hex');

      expect(fetchSpy).toHaveBeenCalledWith(
        hook.url,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-MACP-Signature': expectedSignature,
            'X-MACP-Event': 'run.completed',
          }),
          body,
        }),
      );
    });

    it('should mark delivered on success', async () => {
      const hook = makeWebhook();
      webhookRepository.listActive.mockResolvedValue([hook] as any);
      deliveryRepository.create.mockResolvedValue(makeDelivery({ id: 'del-success' }) as any);
      fetchSpy.mockResolvedValue({ ok: true, status: 200 } as Response);

      await service.fireEvent(samplePayload);
      await jest.advanceTimersByTimeAsync(0);

      expect(deliveryRepository.markDelivered).toHaveBeenCalledWith('del-success', 200);
      expect(instrumentation.webhookDeliveriesTotal.inc).toHaveBeenCalledWith({ status: 'delivered' });
    });

    it('should retry on failure with exponential backoff', async () => {
      const hook = makeWebhook();
      webhookRepository.listActive.mockResolvedValue([hook] as any);
      deliveryRepository.create.mockResolvedValue(makeDelivery({ id: 'del-retry' }) as any);

      // Fail first two, succeed on third
      fetchSpy
        .mockRejectedValueOnce(new Error('network error'))
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response);

      await service.fireEvent(samplePayload);

      // Attempt 1 fires immediately, fails, waits 1000ms backoff
      await jest.advanceTimersByTimeAsync(0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(deliveryRepository.markFailed).toHaveBeenCalledWith('del-retry', 1, 'network error');

      // Advance past 1000ms backoff → attempt 2
      await jest.advanceTimersByTimeAsync(1000);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(deliveryRepository.markFailed).toHaveBeenCalledWith('del-retry', 2, 'timeout');

      // Advance past 2000ms backoff → attempt 3
      await jest.advanceTimersByTimeAsync(2000);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(deliveryRepository.markDelivered).toHaveBeenCalledWith('del-retry', 200);
    });

    it('should retry on non-ok response status', async () => {
      const hook = makeWebhook();
      webhookRepository.listActive.mockResolvedValue([hook] as any);
      deliveryRepository.create.mockResolvedValue(makeDelivery({ id: 'del-500' }) as any);

      fetchSpy
        .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response);

      await service.fireEvent(samplePayload);

      // Attempt 1 gets 500
      await jest.advanceTimersByTimeAsync(0);
      expect(deliveryRepository.markFailed).toHaveBeenCalledWith('del-500', 1, 'webhook returned 500');

      // Advance past 1000ms backoff → attempt 2 succeeds
      await jest.advanceTimersByTimeAsync(1000);
      expect(deliveryRepository.markDelivered).toHaveBeenCalledWith('del-500', 200);
    });

    it('should mark failed and increment failed counter after max attempts', async () => {
      const hook = makeWebhook();
      webhookRepository.listActive.mockResolvedValue([hook] as any);
      deliveryRepository.create.mockResolvedValue(makeDelivery({ id: 'del-fail' }) as any);

      // Fail all 3 attempts
      fetchSpy.mockRejectedValue(new Error('server down'));

      await service.fireEvent(samplePayload);

      // Attempt 1
      await jest.advanceTimersByTimeAsync(0);
      expect(deliveryRepository.markFailed).toHaveBeenCalledWith('del-fail', 1, 'server down');

      // Attempt 2 (after 1000ms backoff)
      await jest.advanceTimersByTimeAsync(1000);
      expect(deliveryRepository.markFailed).toHaveBeenCalledWith('del-fail', 2, 'server down');

      // Attempt 3 (after 2000ms backoff)
      await jest.advanceTimersByTimeAsync(2000);
      expect(deliveryRepository.markFailed).toHaveBeenCalledWith('del-fail', 3, 'server down');

      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(instrumentation.webhookDeliveriesTotal.inc).toHaveBeenCalledWith({ status: 'failed' });
      expect(deliveryRepository.markDelivered).not.toHaveBeenCalled();
    });

    it('should not retry after max attempts are exhausted', async () => {
      const hook = makeWebhook();
      webhookRepository.listActive.mockResolvedValue([hook] as any);
      deliveryRepository.create.mockResolvedValue(makeDelivery({ id: 'del-done' }) as any);

      fetchSpy.mockRejectedValue(new Error('fail'));

      await service.fireEvent(samplePayload);

      // Exhaust all 3 attempts
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(1000);
      await jest.advanceTimersByTimeAsync(2000);

      expect(fetchSpy).toHaveBeenCalledTimes(3);

      // Advance further — no additional calls
      await jest.advanceTimersByTimeAsync(10000);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });
  });

  // ─── retryPending ──────────────────────────────────────────────────

  describe('retryPending', () => {
    it('should retry pending deliveries and return count', async () => {
      const delivery1 = makeDelivery({ id: 'del-p1', webhookId: 'wh-1', attempts: 1 });
      const delivery2 = makeDelivery({ id: 'del-p2', webhookId: 'wh-2', attempts: 0 });
      deliveryRepository.listPending.mockResolvedValue([delivery1, delivery2] as any);
      webhookRepository.findById.mockResolvedValue(makeWebhook() as any);

      const retried = await service.retryPending();

      expect(retried).toBe(2);
      expect(webhookRepository.findById).toHaveBeenCalledWith('wh-1');
      expect(webhookRepository.findById).toHaveBeenCalledWith('wh-2');
    });

    it('should skip deliveries whose webhook no longer exists', async () => {
      const delivery = makeDelivery({ id: 'del-orphan', webhookId: 'wh-deleted' });
      deliveryRepository.listPending.mockResolvedValue([delivery] as any);
      webhookRepository.findById.mockResolvedValue(null as any);

      const retried = await service.retryPending();

      expect(retried).toBe(0);
      // fetch should not be called since we skipped the orphaned delivery
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should resume from the delivery attempt count (startAttempt)', async () => {
      // Delivery already has 2 attempts — only 1 attempt left (attempt 3)
      const delivery = makeDelivery({ id: 'del-resume', webhookId: 'wh-1', attempts: 2 });
      deliveryRepository.listPending.mockResolvedValue([delivery] as any);
      webhookRepository.findById.mockResolvedValue(makeWebhook() as any);

      fetchSpy.mockRejectedValue(new Error('still failing'));

      const retried = await service.retryPending();
      expect(retried).toBe(1);

      // Let the single remaining attempt fire
      await jest.advanceTimersByTimeAsync(0);

      // Only 1 fetch call (attempt 3, the final one)
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(deliveryRepository.markFailed).toHaveBeenCalledWith('del-resume', 3, 'still failing');
      expect(instrumentation.webhookDeliveriesTotal.inc).toHaveBeenCalledWith({ status: 'failed' });
    });

    it('should return 0 when no pending deliveries exist', async () => {
      deliveryRepository.listPending.mockResolvedValue([]);

      const retried = await service.retryPending();

      expect(retried).toBe(0);
      expect(webhookRepository.findById).not.toHaveBeenCalled();
    });
  });
});
