import { WebhookController } from './webhook.controller';
import { WebhookService } from '../webhooks/webhook.service';
import { CreateWebhookDto } from '../dto/webhook.dto';
import { UpdateWebhookDto } from '../dto/update-webhook.dto';

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

  describe('deleteWebhook', () => {
    it('should call webhookService.remove with id', async () => {
      await controller.deleteWebhook('wh-1');

      expect(mockWebhookService.remove).toHaveBeenCalledWith('wh-1');
    });
  });
});
