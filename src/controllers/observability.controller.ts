import { Body, Controller, Get, Param, ParseUUIDPipe, Post, ValidationPipe } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ArtifactService } from '../artifacts/artifact.service';
import { CanonicalEvent } from '../contracts/control-plane';
import { CreateArtifactDto } from '../dto/create-artifact.dto';
import { MetricsSummaryDto } from '../dto/run-responses.dto';
import { RunEventService } from '../events/run-event.service';
import { MetricsService } from '../metrics/metrics.service';
import { ProjectionService } from '../projection/projection.service';
import { EventRepository } from '../storage/event.repository';
import { RunManagerService } from '../runs/run-manager.service';

@ApiTags('observability')
@Controller()
export class ObservabilityController {
  constructor(
    private readonly runManager: RunManagerService,
    private readonly artifactService: ArtifactService,
    private readonly metricsService: MetricsService,
    private readonly projectionService: ProjectionService,
    private readonly eventService: RunEventService,
    private readonly eventRepository: EventRepository
  ) {}

  @Get('runs/:id/traces')
  @ApiOperation({ summary: 'Fetch trace summary for a run.' })
  async getTraces(@Param('id', new ParseUUIDPipe()) id: string) {
    await this.runManager.getRun(id);
    const state = await this.projectionService.get(id);
    return state?.trace ?? { spanCount: 0, linkedArtifacts: [] };
  }

  @Get('runs/:id/artifacts')
  @ApiOperation({ summary: 'List artifacts linked to a run.' })
  async getArtifacts(@Param('id', new ParseUUIDPipe()) id: string) {
    await this.runManager.getRun(id);
    return this.artifactService.list(id);
  }

  @Post('runs/:id/artifacts')
  @ApiOperation({ summary: 'Create an artifact linked to a run.' })
  @ApiBody({ type: CreateArtifactDto })
  @ApiCreatedResponse({ description: 'Artifact created.' })
  async createArtifact(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true })) body: CreateArtifactDto
  ) {
    await this.runManager.getRun(id);
    const artifact = await this.artifactService.register({
      runId: id,
      kind: body.kind,
      label: body.label,
      uri: body.uri,
      inline: body.inline
    });
    await this.eventService.emitControlPlaneEvents(id, [
      {
        ts: new Date().toISOString(),
        type: 'artifact.created',
        source: { kind: 'control-plane', name: 'observability-controller' },
        subject: { kind: 'artifact', id: artifact.id },
        data: {
          kind: artifact.kind,
          label: artifact.label,
          artifactId: artifact.id,
          uri: artifact.uri
        }
      }
    ]);
    return artifact;
  }

  @Get('runs/:id/metrics')
  @ApiOperation({ summary: 'Fetch metrics summary for a run.' })
  @ApiOkResponse({ type: MetricsSummaryDto })
  async getMetrics(@Param('id', new ParseUUIDPipe()) id: string) {
    await this.runManager.getRun(id);
    return (await this.metricsService.get(id)) ?? {
      runId: id,
      eventCount: 0,
      messageCount: 0,
      signalCount: 0,
      proposalCount: 0,
      toolCallCount: 0,
      decisionCount: 0,
      streamReconnectCount: 0
    };
  }

  @Post('runs/:id/projection/rebuild')
  @ApiOperation({ summary: 'Rebuild the projection for a run from canonical events.' })
  async rebuildProjection(@Param('id', new ParseUUIDPipe()) id: string) {
    await this.runManager.getRun(id);
    const events = await this.eventRepository.listCanonicalUpTo(id);
    const projection = await this.projectionService.rebuild(id, events as unknown as CanonicalEvent[]);
    return { rebuilt: true, latestSeq: projection.timeline.latestSeq };
  }
}
