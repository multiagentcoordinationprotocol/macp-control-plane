import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  ValidationPipe
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CompareRunsDto } from '../dto/compare-runs.dto';
import { ExportRunQueryDto } from '../dto/export-run-query.dto';
import { RunBundleExportDto, RunComparisonResultDto } from '../dto/run-responses.dto';
import { RunInsightsService } from '../insights/run-insights.service';
import { RunExecutorService } from '../runs/run-executor.service';
import { RunManagerService } from '../runs/run-manager.service';

@ApiTags('runs')
@Controller('runs')
export class RunInsightsController {
  constructor(
    private readonly insightsService: RunInsightsService,
    private readonly runExecutor: RunExecutorService,
    private readonly runManager: RunManagerService
  ) {}

  @Get(':id/export')
  @ApiOperation({ summary: 'Export a full run bundle (run, session, projection, events, artifacts).' })
  @ApiOkResponse({ type: RunBundleExportDto })
  async exportRun(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ValidationPipe({ transform: true, whitelist: true })) query: ExportRunQueryDto
  ) {
    if (query.format === 'jsonl') {
      const jsonl = await this.insightsService.exportRunJsonl(id, {
        includeCanonical: query.includeCanonical,
        includeRaw: query.includeRaw,
        eventLimit: query.eventLimit
      });
      return jsonl;
    }
    return this.insightsService.exportRun(id, {
      includeCanonical: query.includeCanonical,
      includeRaw: query.includeRaw,
      eventLimit: query.eventLimit
    });
  }

  @Get(':id/export/stream')
  @ApiOperation({ summary: 'Stream export as JSONL (newline-delimited JSON).' })
  @Header('Content-Type', 'application/x-ndjson')
  async streamExport(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ValidationPipe({ transform: true, whitelist: true })) query: ExportRunQueryDto,
    @Res() res: Response
  ) {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');
    for await (const line of this.insightsService.exportRunStream(id, {
      includeRaw: query.includeRaw
    })) {
      res.write(line);
    }
    res.end();
  }

  @Post('compare')
  @ApiOperation({ summary: 'Compare two runs side-by-side.' })
  @ApiBody({ type: CompareRunsDto })
  @ApiOkResponse({ type: RunComparisonResultDto })
  async compareRuns(
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) body: CompareRunsDto
  ) {
    return this.insightsService.compareRuns(body.leftRunId, body.rightRunId);
  }

  @Post('batch/cancel')
  @ApiOperation({ summary: 'Cancel multiple runs in batch.' })
  async batchCancel(
    @Body(new ValidationPipe({ transform: true, whitelist: true })) body: { runIds: string[] }
  ) {
    const results = await Promise.allSettled(
      body.runIds.map((id) => this.runExecutor.cancel(id, 'batch cancel'))
    );
    return results.map((result, index) => ({
      runId: body.runIds[index],
      status: result.status === 'fulfilled' ? 'cancelled' : 'failed',
      error: result.status === 'rejected' ? (result.reason instanceof Error ? result.reason.message : String(result.reason)) : undefined
    }));
  }

  @Post('batch/export')
  @ApiOperation({ summary: 'Export multiple runs in batch.' })
  async batchExport(
    @Body(new ValidationPipe({ transform: true, whitelist: true })) body: { runIds: string[] }
  ) {
    return Promise.all(
      body.runIds.map((id) => this.insightsService.exportRun(id, { includeCanonical: true, includeRaw: false }))
    );
  }

  @Post('batch/archive')
  @ApiOperation({ summary: 'Archive multiple runs in batch.' })
  async batchArchive(
    @Body(new ValidationPipe({ transform: true, whitelist: true })) body: { runIds: string[] }
  ) {
    const results = await Promise.allSettled(
      body.runIds.map((id) => this.runManager.archiveRun(id))
    );
    return results.map((result, index) => ({
      runId: body.runIds[index],
      status: result.status === 'fulfilled' ? 'archived' : 'failed',
      error: result.status === 'rejected' ? (result.reason instanceof Error ? result.reason.message : String(result.reason)) : undefined
    }));
  }

  @Post('batch/delete')
  @ApiOperation({ summary: 'Delete multiple terminal runs in batch.' })
  async batchDelete(
    @Body(new ValidationPipe({ transform: true, whitelist: true })) body: { runIds: string[] }
  ) {
    const results = await Promise.allSettled(
      body.runIds.map((id) => this.runManager.deleteRun(id))
    );
    return results.map((result, index) => ({
      runId: body.runIds[index],
      status: result.status === 'fulfilled' ? 'deleted' : 'failed',
      error: result.status === 'rejected' ? (result.reason instanceof Error ? result.reason.message : String(result.reason)) : undefined
    }));
  }
}
