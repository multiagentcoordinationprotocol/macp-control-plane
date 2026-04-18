import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  MessageEvent,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Sse,
  ValidationPipe
} from '@nestjs/common';
import { ApiAcceptedResponse, ApiBody, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { map, Observable } from 'rxjs';
import { CanonicalEvent, ReplayRequest, RunStatus } from '../contracts/control-plane';
import { AppConfigService } from '../config/app-config.service';
import { RunDescriptorDto } from '../dto/run-descriptor.dto';
import { ListEventsQueryDto } from '../dto/list-events-query.dto';
import { ListRunsQueryDto } from '../dto/list-runs-query.dto';
import { ReplayRequestDto } from '../dto/replay-request.dto';
import { CloneRunDto } from '../dto/clone-run.dto';
import { StreamRunQueryDto } from '../dto/stream-run-query.dto';
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

/**
 * RFC-MACP-0001 §5.3 forbids HTTP bypass of MACP. Control-plane removed all
 * envelope-emission endpoints (direct-agent-auth CP-5/6/7). Agents use the
 * macp-sdk-python / macp-sdk-typescript clients to emit envelopes directly.
 */
const MIGRATION_URL = 'https://github.com/multiagentcoordinationprotocol/docs/blob/main/ONBOARDING_AN_AGENT.md';

function gone(endpoint: string): never {
  throw new HttpException(
    {
      statusCode: HttpStatus.GONE,
      errorCode: 'ENDPOINT_REMOVED',
      message: `${endpoint} has been removed. Agents authenticate to the runtime directly via macp-sdk-python / macp-sdk-typescript. See ${MIGRATION_URL}`
    },
    HttpStatus.GONE,
    {
      cause: new Error(`${endpoint} removed (direct-agent-auth)`)
    }
  );
}

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
  @ApiOperation({ summary: 'Preflight validation of a RunDescriptor without creating a run.' })
  @ApiBody({ type: RunDescriptorDto })
  async validateRequest(
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    body: RunDescriptorDto
  ) {
    return this.runExecutor.validate(body);
  }

  @Get()
  @ApiOperation({ summary: 'List runs with optional filtering and pagination.' })
  async listRuns(@Query(new ValidationPipe({ transform: true, whitelist: true })) query: ListRunsQueryDto) {
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
  @ApiOperation({
    summary:
      'Create and launch a runtime execution run. Returns {runId, sessionId} — caller distributes sessionId to agents via bootstrap.'
  })
  @ApiAcceptedResponse({ type: CreateRunResponseDto })
  @ApiBody({ type: RunDescriptorDto })
  async createRun(
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    body: RunDescriptorDto
  ) {
    const { run, sessionId } = await this.runExecutor.launch(body);
    return {
      runId: run.id,
      sessionId,
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
  @ApiOperation({ summary: 'List canonical events for a run with optional time-range and type filters.' })
  @ApiQuery({ name: 'afterSeq', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'afterTs', required: false })
  @ApiQuery({ name: 'beforeTs', required: false })
  @ApiQuery({ name: 'type', required: false, description: 'Comma-separated canonical event types' })
  @ApiOkResponse({ type: [CanonicalEventDto] })
  async getRunEvents(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ValidationPipe({ transform: true, whitelist: true })) query: ListEventsQueryDto
  ) {
    if (!query.afterTs && !query.beforeTs && !query.type) {
      return this.eventRepository.listCanonicalByRun(id, query.afterSeq ?? 0, query.limit ?? 200);
    }
    const { data, total } = await this.eventRepository.listCanonicalFiltered({
      runId: id,
      afterSeq: query.afterSeq,
      afterTs: query.afterTs,
      beforeTs: query.beforeTs,
      types: query.type
        ? query.type
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined,
      limit: query.limit ?? 200
    });
    const limit = query.limit ?? 200;
    const nextCursor = data.length > 0 ? data[data.length - 1].seq : undefined;
    return { data, total, limit, nextCursor };
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

      const heartbeatTimer = setInterval(() => {
        subscriber.next({ type: 'heartbeat', data: { ts: new Date().toISOString() } } as MessageEvent);
      }, heartbeatMs);
      if (typeof heartbeatTimer === 'object' && 'unref' in heartbeatTimer) {
        heartbeatTimer.unref();
      }

      const runBackfill = async () => {
        try {
          if (includeSnapshot) {
            const state = await this.runManager.getState(id);
            subscriber.next({ type: 'snapshot', data: state } as MessageEvent);
          }

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
  @ApiOperation({
    summary:
      "Cancel a running session. Default: proxies to the initiator agent's cancelCallback (Option A). " +
      'Policy-delegated fallback (metadata.cancellationDelegated=true) calls runtime.CancelSession (Option B).'
  })
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
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) body: ReplayRequestDto
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
  async getReplayState(@Param('id', new ParseUUIDPipe()) id: string, @Query('seq') seq?: string) {
    return this.replayService.stateAt(id, seq ? Number(seq) : undefined);
  }

  // ── REMOVED: envelope-emission endpoints (direct-agent-auth CP-5/6/7) ─────
  // These endpoints violated the invariant that the control-plane must NEVER call Send.
  // They return 410 Gone with a migration header pointing to the SDK docs.

  @Post(':id/messages')
  @ApiOperation({
    summary: 'REMOVED. Agents emit session-bound messages via the macp-sdk directly.',
    deprecated: true
  })
  sendMessage(@Param('id', new ParseUUIDPipe()) _id: string): never {
    gone('POST /runs/:id/messages');
  }

  @Post(':id/signal')
  @ApiOperation({
    summary: 'REMOVED. Agents emit signals via the macp-sdk directly.',
    deprecated: true
  })
  sendSignal(@Param('id', new ParseUUIDPipe()) _id: string): never {
    gone('POST /runs/:id/signal');
  }

  @Post(':id/context')
  @ApiOperation({
    summary: 'REMOVED. Agents emit ContextUpdate envelopes via the macp-sdk directly.',
    deprecated: true
  })
  updateContext(@Param('id', new ParseUUIDPipe()) _id: string): never {
    gone('POST /runs/:id/context');
  }

  @Post(':id/clone')
  @ApiOperation({ summary: 'Clone a run with optional tag overrides (produces a fresh sessionId).' })
  @ApiBody({ type: CloneRunDto })
  async cloneRun(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) body: CloneRunDto
  ) {
    if (body.context && Object.keys(body.context).length > 0) {
      throw new BadRequestException(
        'context overrides are no longer accepted — session context is opaque to the control-plane ' +
          "(direct-agent-auth §Invariants). Pass any scenario-specific overrides via the caller's " +
          'scenario compiler and submit a fresh POST /runs.'
      );
    }
    const { run, sessionId } = await this.runExecutor.clone(id, { tags: body.tags });
    return {
      runId: run.id,
      sessionId,
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
  @ApiOperation({ summary: 'List outbound messages captured from the runtime stream for a run.' })
  async getRunMessages(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.outboundMessageRepository.listByRunId(id);
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
