import { Controller, Get, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { InstrumentationService } from '../telemetry/instrumentation.service';

@ApiTags('metrics')
// Not @Public(): process and per-route counters are operational data, so /metrics needs the API key
// like every other non-probe route. Scrapers send `Authorization: Bearer <key>`.
@Controller()
export class MetricsController {
  constructor(private readonly instrumentation: InstrumentationService) {}

  @Get('metrics')
  @ApiOperation({ summary: 'Prometheus metrics for the control-plane process (text exposition format).' })
  @ApiProduces('text/plain')
  @ApiOkResponse({ content: { 'text/plain': { schema: { type: 'string' } } } })
  async getMetrics(@Res() res: Response): Promise<void> {
    const metrics = await this.instrumentation.getMetrics();
    res.set('Content-Type', this.instrumentation.getContentType());
    res.end(metrics);
  }
}
