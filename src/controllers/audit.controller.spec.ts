import { AuditController } from './audit.controller';
import { AuditService } from '../audit/audit.service';
import { ListAuditQueryDto } from '../dto/list-audit-query.dto';

describe('AuditController', () => {
  let controller: AuditController;
  let mockAuditService: {
    list: jest.Mock;
  };

  beforeEach(() => {
    mockAuditService = {
      list: jest.fn().mockResolvedValue([])
    };

    controller = new AuditController(mockAuditService as unknown as AuditService);
  });

  describe('listAuditLogs', () => {
    it('should call auditService.list with correct params', async () => {
      const query: ListAuditQueryDto = {
        actor: 'user-1',
        action: 'run.create',
        resource: 'run',
        resourceId: 'run-123',
        createdAfter: '2025-01-01',
        createdBefore: '2025-12-31',
        limit: 25,
        offset: 10
      };

      await controller.listAuditLogs(query);

      expect(mockAuditService.list).toHaveBeenCalledWith({
        actor: 'user-1',
        action: 'run.create',
        resource: 'run',
        resourceId: 'run-123',
        createdAfter: '2025-01-01',
        createdBefore: '2025-12-31',
        limit: 25,
        offset: 10
      });
    });

    it('should default limit to 50 and offset to 0 when not provided', async () => {
      const query: ListAuditQueryDto = {};

      await controller.listAuditLogs(query);

      expect(mockAuditService.list).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 50,
          offset: 0
        })
      );
    });

    it('should pass through actor, action, and resource filters', async () => {
      const query: ListAuditQueryDto = {
        actor: 'admin',
        action: 'run.delete',
        resource: 'run'
      };

      await controller.listAuditLogs(query);

      expect(mockAuditService.list).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: 'admin',
          action: 'run.delete',
          resource: 'run'
        })
      );
    });
  });
});
