import { Controller, Get, Query, ValidationPipe } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DashboardOverviewDto, DashboardOverviewQueryDto } from '../dto/dashboard-overview.dto';
import { DashboardService } from '../dashboard/dashboard.service';

@ApiTags('dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('overview')
  @ApiOperation({
    summary: 'Aggregated dashboard KPIs and chart data (§5.1 — window + scenarioRef + environment filters).'
  })
  @ApiOkResponse({ type: DashboardOverviewDto })
  async getOverview(
    @Query(new ValidationPipe({ transform: true, whitelist: true }))
    query: DashboardOverviewQueryDto
  ) {
    return this.dashboardService.getOverview({
      window: query.window ?? query.range ?? '24h',
      from: query.from,
      to: query.to,
      scenarioRef: query.scenarioRef,
      environment: query.environment
    });
  }

  @Get('agents/metrics')
  @ApiOperation({ summary: 'Aggregated per-agent metrics from canonical events.' })
  async getAgentMetrics() {
    return this.dashboardService.getAgentMetrics();
  }
}
