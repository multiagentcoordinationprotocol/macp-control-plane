import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  MessageEvent,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Sse,
  ValidationPipe
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags
} from '@nestjs/swagger';
import { map, Observable } from 'rxjs';
import { CanonicalEvent, ReplayRequest, RunStatus } from '../contracts/control-plane';
import { AppConfigService } from '../config/app-config.service';
import { ExecutionRequestDto } from '../dto/execution-request.dto';
import { ListEventsQueryDto } from '../dto/list-events-query.dto';
import { ListRunsQueryDto } from '../dto/list-runs-query.dto';
import { ReplayRequestDto } from '../dto/replay-request.dto';
import { CloneRunDto } from '../dto/clone-run.dto';
import { SendRunMessageDto } from '../dto/send-run-message.dto';
import { SendSignalDto } from '../dto/send-signal.dto';
import { StreamRunQueryDto } from '../dto/stream-run-query.dto';
import { UpdateContextDto } from '../dto/update-context.dto';
import { ProjectionService } from '../projection/projection.service';
import { OutboundMessageRepository } from '../storage/outbound-message.repository';
import {
  CanonicalEventDto,
  CreateRunResponseDto,
  ReplayDescriptorDto,
  RunStateResponseDto
} from '../dto/run-responses.dto';
import { StreamHubService, StreamHubMessage } from '../events/stream-hub.service';
import { InstrumentationService } from '../telemetry/instrumentation.service';
import { ReplayService } from '../replay/replay.service';
import { EventRepository } from '../storage/event.repository';
import { RunExecutorService } from '../runs/run-executor.service';
import { RunManagerService } from '../runs/run-manager.service';

@ApiTags('runs')
@Controller('runs')
export class RunsController {
  constructor(
    private readonly runExecutor: RunExecutorService,
    private readonly runManager: RunManagerService,
    private readonly eventRepository: EventRepository,
    private readonly replayService: ReplayService,
    private readonly streamHub: StreamHubService,
    private readonly config: AppConfigService,
    private readonly projectionService: ProjectionService,
    private readonly outboundMessageRepository: OutboundMessageRepository,
    private readonly instrumentation: InstrumentationService
  ) {}

  @Post('validate')
  @ApiOperation({ summary: 'Preflight validation of an execution request without creating a run.' })
  @ApiBody({ type: ExecutionRequestDto })
  async validateRequest(
    @Body(new ValidationPipe({ transform: true, whitelist: true })) body: ExecutionRequestDto
  ) {
    return this.runExecutor.validate(body);
  }

  @Get()
  @ApiOperation({ summary: 'List runs with optional filtering and pagination.' })
  async listRuns(
    @Query(new ValidationPipe({ transform: true, whitelist: true })) query: ListRunsQueryDto
  ) {
    return this.runManager.listRuns({
      status: query.status,
      tags: query.tags,
      createdAfter: query.createdAfter,
      createdBefore: query.createdBefore,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
      sortBy: query.sortBy ?? 'createdAt',
      sortOrder: query.sortOrder ?? 'desc',
      includeSandbox: query.includeSandbox,
      includeArchived: query.includeArchived,
      environment: query.environment,
      scenarioRef: query.scenarioRef,
      search: query.search
    });
  }

  @Post()
  @ApiOperation({ summary: 'Create and launch a runtime execution run.' })
  @ApiAcceptedResponse({ type: CreateRunResponseDto })
  @ApiBody({ type: ExecutionRequestDto })
  async createRun(@Body(new ValidationPipe({ transform: true, whitelist: true })) body: ExecutionRequestDto) {
    const run = await this.runExecutor.launch(body);
    return {
      runId: run.id,
      status: run.status as RunStatus,
      traceId: run.traceId ?? undefined
    } satisfies CreateRunResponseDto;
  }

  @Get(':id')
  @ApiOperation({ summary: 'Fetch the run record.' })
  async getRun(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.runManager.getRun(id);
  }

  @Get(':id/state')
  @ApiOperation({ summary: 'Fetch the projected run state for UI rendering.' })
  @ApiOkResponse({ type: RunStateResponseDto })
  async getRunState(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.runManager.getState(id);
  }

  @Get(':id/events')
  @ApiOperation({ summary: 'List canonical events for a run.' })
  @ApiQuery({ name: 'afterSeq', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiOkResponse({ type: [CanonicalEventDto] })
  async getRunEvents(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ValidationPipe({ transform: true, whitelist: true })) query: ListEventsQueryDto
  ) {
    return this.eventRepository.listCanonicalByRun(id, query.afterSeq ?? 0, query.limit ?? 200);
  }

  @Sse(':id/stream')
  @ApiOperation({ summary: 'Subscribe to normalized live run events over SSE with resume support.' })
  streamRun(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ValidationPipe({ transform: true, whitelist: true })) query: StreamRunQueryDto,
    @Headers('last-event-id') lastEventId?: string
  ): Observable<MessageEvent> {
    const afterSeq = query.afterSeq ?? (lastEventId ? Number(lastEventId) : 0);
    const includeSnapshot = query.includeSnapshot !== false;
    const heartbeatMs = query.heartbeatMs ?? this.config.streamSseHeartbeatMs;

    return new Observable<MessageEvent>((subscriber) => {
      this.instrumentation.activeSseConnections.inc();
      const buffer: StreamHubMessage[] = [];
      let backfillDone = false;
      let highSeq = afterSeq;

      // 1. Subscribe to live hub immediately, buffer during backfill
      const liveSub = this.streamHub.stream(id).subscribe({
        next: (msg) => {
          if (!backfillDone) {
            buffer.push(msg);
            return;
          }
          const seq = (msg.data as CanonicalEvent)?.seq;
          if (seq !== undefined && seq <= highSeq) return;
          if (seq !== undefined) highSeq = seq;
          subscriber.next({
            type: msg.event,
            data: msg.data,
            ...(seq !== undefined ? { id: String(seq) } : {})
          } as MessageEvent);
        },
        complete: () => subscriber.complete(),
        error: (err) => subscriber.error(err)
      });

      // 2. Heartbeat
      const heartbeatTimer = setInterval(() => {
        subscriber.next({ type: 'heartbeat', data: { ts: new Date().toISOString() } } as MessageEvent);
      }, heartbeatMs);
      if (typeof heartbeatTimer === 'object' && 'unref' in heartbeatTimer) {
        heartbeatTimer.unref();
      }

      // 3. Backfill + drain buffer
      const runBackfill = async () => {
        try {
          // Emit snapshot if requested
          if (includeSnapshot) {
            const state = await this.runManager.getState(id);
            subscriber.next({ type: 'snapshot', data: state } as MessageEvent);
          }

          // Backfill missed canonical events in batches
          if (afterSeq > 0) {
            let cursor = afterSeq;
            const batchSize = 500;
            while (true) {
              const events = await this.eventRepository.listCanonicalByRun(id, cursor, batchSize);
              for (const event of events) {
                if (event.seq <= highSeq) continue;
                highSeq = event.seq;
                subscriber.next({
                  type: 'canonical_event',
                  data: event,
                  id: String(event.seq)
                } as MessageEvent);
              }
              if (events.length < batchSize) break;
              cursor = events[events.length - 1].seq;
            }
          }

          // Drain buffer, deduplicating by seq
          backfillDone = true;
          for (const msg of buffer) {
            const seq = (msg.data as CanonicalEvent)?.seq;
            if (seq !== undefined && seq <= highSeq) continue;
            if (seq !== undefined) highSeq = seq;
            subscriber.next({
              type: msg.event,
              data: msg.data,
              ...(seq !== undefined ? { id: String(seq) } : {})
            } as MessageEvent);
          }
          buffer.length = 0;
        } catch (err) {
          subscriber.error(err);
        }
      };

      void runBackfill();

      return () => {
        this.instrumentation.activeSseConnections.dec();
        clearInterval(heartbeatTimer);
        liveSub.unsubscribe();
      };
    });
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancel a running session in the runtime.' })
  async cancelRun(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true })) body: { reason?: string }
  ) {
    return this.runExecutor.cancel(id, body?.reason);
  }

  @Post(':id/replay')
  @ApiOperation({ summary: 'Create a replay descriptor for a prior run.' })
  @ApiAcceptedResponse({ type: ReplayDescriptorDto })
  async createReplay(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true })) body: ReplayRequestDto
  ) {
    const replay: ReplayRequest = {
      mode: body.mode ?? 'timed',
      speed: body.speed ?? 1,
      fromSeq: body.fromSeq,
      toSeq: body.toSeq
    };
    return this.replayService.describe(id, replay);
  }

  @Sse(':id/replay/stream')
  @ApiOperation({ summary: 'Replay a run using persisted canonical events.' })
  streamReplay(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ValidationPipe({ transform: true, whitelist: true })) query: ReplayRequestDto
  ): Observable<MessageEvent> {
    return this.replayService
      .stream(id, {
        mode: query.mode ?? 'timed',
        speed: query.speed ?? 1,
        fromSeq: query.fromSeq,
        toSeq: query.toSeq
      })
      .pipe(map((item) => ({ type: item.type, data: item.data }) as MessageEvent));
  }

  @Get(':id/replay/state')
  @ApiOperation({ summary: 'Project run state at a specific event sequence for scrubber/replay UIs.' })
  async getReplayState(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('seq') seq?: string
  ) {
    return this.replayService.stateAt(id, seq ? Number(seq) : undefined);
  }

  @Post(':id/messages')
  @ApiOperation({ summary: 'Send a session-bound MACP message to a running session.' })
  @ApiBody({ type: SendRunMessageDto })
  async sendMessage(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true })) body: SendRunMessageDto
  ) {
    return this.runExecutor.sendMessage(id, body);
  }

  @Post(':id/signal')
  @ApiOperation({ summary: 'Send a signal to a running session.' })
  @ApiBody({ type: SendSignalDto })
  async sendSignal(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true })) body: SendSignalDto
  ) {
    // Runtime requires non-empty signal_type when payload is present
    if (body.payload && Object.keys(body.payload).length > 0 && !body.signalType) {
      throw new BadRequestException('signalType is required when payload is non-empty');
    }
    this.instrumentation.signalsTotal.inc({ signal_type: body.signalType ?? body.messageType ?? 'unknown' });
    return this.runExecutor.sendSignal(id, body);
  }

  @Post(':id/clone')
  @ApiOperation({ summary: 'Clone a run with optional overrides.' })
  @ApiBody({ type: CloneRunDto })
  async cloneRun(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true })) body: CloneRunDto
  ) {
    const run = await this.runExecutor.clone(id, body);
    return {
      runId: run.id,
      status: run.status,
      traceId: run.traceId ?? undefined
    };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a terminal run and all associated data.' })
  @HttpCode(204)
  async deleteRun(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.runManager.deleteRun(id);
  }

  @Get(':id/messages')
  @ApiOperation({ summary: 'List outbound messages for a run.' })
  async getRunMessages(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.outboundMessageRepository.listByRunId(id);
  }

  @Post(':id/context')
  @ApiOperation({ summary: 'Update context during a running session.' })
  @ApiBody({ type: UpdateContextDto })
  async updateContext(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true })) body: UpdateContextDto
  ) {
    return this.runExecutor.updateContext(id, body);
  }

  @Post(':id/projection/rebuild')
  @ApiOperation({ summary: 'Rebuild the projection from persisted canonical events.' })
  async rebuildProjection(@Param('id', new ParseUUIDPipe()) id: string) {
    await this.runManager.getRun(id);
    const events = await this.eventRepository.listCanonicalByRun(id, 0, 100000);
    return this.projectionService.rebuild(id, events as unknown as CanonicalEvent[]);
  }

  @Post(':id/archive')
  @ApiOperation({ summary: 'Archive a run, excluding it from default listings.' })
  async archiveRun(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.runManager.archiveRun(id);
  }

}
