import { Controller, Get, Query, ValidationPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ListCrossRunEventsQueryDto } from '../dto/list-events-query.dto';
import { EventRepository } from '../storage/event.repository';

@ApiTags('events')
@Controller('events')
export class EventsController {
  constructor(private readonly eventRepository: EventRepository) {}

  @Get()
  @ApiOperation({
    summary: 'Cross-run canonical events with filters (§4.1).'
  })
  async listEvents(@Query(new ValidationPipe({ transform: true, whitelist: true })) query: ListCrossRunEventsQueryDto) {
    const { data, total } = await this.eventRepository.listCanonicalFiltered({
      runId: query.runId,
      afterSeq: query.afterSeq,
      afterTs: query.afterTs,
      beforeTs: query.beforeTs,
      types: query.type
        ? query.type
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined,
      scenarioRef: query.scenarioRef,
      limit: query.limit ?? 500
    });
    const limit = query.limit ?? 500;
    const nextCursor = data.length === limit ? data[data.length - 1].seq : undefined;
    return { data, total, limit, nextCursor };
  }
}
