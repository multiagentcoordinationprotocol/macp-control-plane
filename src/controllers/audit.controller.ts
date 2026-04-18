import { Controller, Get, Query, ValidationPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuditService } from '../audit/audit.service';
import { ListAuditQueryDto } from '../dto/list-audit-query.dto';

@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @ApiOperation({ summary: 'List audit log entries with optional filtering.' })
  async listAuditLogs(@Query(new ValidationPipe({ transform: true, whitelist: true })) query: ListAuditQueryDto) {
    return this.auditService.list({
      actor: query.actor,
      action: query.action,
      resource: query.resource,
      resourceId: query.resourceId,
      createdAfter: query.createdAfter,
      createdBefore: query.createdBefore,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0
    });
  }
}
