import { WebhookController } from './webhook.controller';
import { WebhookService } from '../webhooks/webhook.service';
import { CreateWebhookDto } from '../dto/webhook.dto';
import { UpdateWebhookDto } from '../dto/update-webhook.dto';

// A stored row, as the repository returns it: the signing secret included.
const storedRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'b3f1c1de-0000-4000-8000-000000000001',
  url: 'https://example.com/hook',
  events: ['run.completed'],
  secret: 'stored-signing-key',
  active: true,
  createdAt: '2026-11-01 12:00:00+00',
  updatedAt: '2026-11-01 12:00:00+00',
  ...overrides
});

const expectNoSecret = (body: unknown) => {
  expect(body).not.toHaveProperty('secret');
  expect(JSON.stringify(body)).not.toContain('stored-signing-key');
};

describe('WebhookController', () => {
  let controller: WebhookController;
  let mockWebhookService: {
    register: jest.Mock;
    list: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
  };

  beforeEach(() => {
    mockWebhookService = {
      register: jest.fn().mockResolvedValue({ id: 'wh-1' }),
      list: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ id: 'wh-1' }),
      remove: jest.fn().mockResolvedValue(undefined)
    };

    controller = new WebhookController(mockWebhookService as unknown as WebhookService);
  });

  describe('createWebhook', () => {
    it('should call webhookService.register with correct params', async () => {
      const body: CreateWebhookDto = {
        url: 'https://example.com/hook',
        events: ['run.completed', 'run.failed'],
        secret: 's3cret'
      };

      await controller.createWebhook(body);

      expect(mockWebhookService.register).toHaveBeenCalledWith({
        url: 'https://example.com/hook',
        events: ['run.completed', 'run.failed'],
        secret: 's3cret'
      });
    });

    it('should default events to empty array when not provided', async () => {
      const body = {
        url: 'https://example.com/hook',
        secret: 's3cret'
      } as CreateWebhookDto;

      await controller.createWebhook(body);

      expect(mockWebhookService.register).toHaveBeenCalledWith({
        url: 'https://example.com/hook',
        events: [],
        secret: 's3cret'
      });
    });
  });

  describe('listWebhooks', () => {
    it('should call webhookService.list', async () => {
      await controller.listWebhooks();

      expect(mockWebhookService.list).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateWebhook', () => {
    it('should call webhookService.update with id and body', async () => {
      const body: UpdateWebhookDto = {
        url: 'https://example.com/new-hook',
        active: false
      };

      await controller.updateWebhook('wh-1', body);

      expect(mockWebhookService.update).toHaveBeenCalledWith('wh-1', {
        url: 'https://example.com/new-hook',
        active: false
      });
    });
  });

  describe('responses never carry the signing secret (#140)', () => {
    const body: CreateWebhookDto = { url: 'https://example.com/hook', events: ['run.completed'], secret: 's3cret' };

    it('createWebhook returns the view, without secret and with hasSecret', async () => {
      mockWebhookService.register.mockResolvedValue(storedRow());
      const res = await controller.createWebhook(body);
      expectNoSecret(res);
      expect(res).toEqual({
        id: 'b3f1c1de-0000-4000-8000-000000000001',
        url: 'https://example.com/hook',
        events: ['run.completed'],
        active: true,
        createdAt: '2026-11-01 12:00:00+00',
        updatedAt: '2026-11-01 12:00:00+00',
        hasSecret: true
      });
    });

    it('listWebhooks strips secret from every row', async () => {
      mockWebhookService.list.mockResolvedValue([storedRow(), storedRow({ id: 'other', secret: '' })]);
      const res = await controller.listWebhooks();
      expect(res).toHaveLength(2);
      res.forEach(expectNoSecret);
      expect(res.map((w) => w.hasSecret)).toEqual([true, false]);
    });

    it('updateWebhook strips secret, also when the update sets a new one', async () => {
      mockWebhookService.update.mockResolvedValue(storedRow({ active: false }));
      const res = await controller.updateWebhook('wh-1', { secret: 'stored-signing-key', active: false });
      expectNoSecret(res);
      expect(res).toMatchObject({ active: false, hasSecret: true });
    });

    it('updateWebhook keeps the empty body for an unknown id', async () => {
      mockWebhookService.update.mockResolvedValue(null);
      await expect(controller.updateWebhook('wh-1', { active: false })).resolves.toBeNull();
    });
  });

  describe('deleteWebhook', () => {
    it('should call webhookService.remove with id', async () => {
      await controller.deleteWebhook('wh-1');

      expect(mockWebhookService.remove).toHaveBeenCalledWith('wh-1');
    });
  });
});
