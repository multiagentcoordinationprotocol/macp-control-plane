import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsString } from 'class-validator';

export class DashboardOverviewQueryDto {
  @ApiPropertyOptional({
    description: 'Named time window (mutually exclusive with from/to)',
    enum: ['1h', '6h', '24h', '7d', '30d'],
    default: '24h'
  })
  @IsOptional()
  @IsIn(['1h', '6h', '24h', '7d', '30d'])
  window?: '1h' | '6h' | '24h' | '7d' | '30d';

  /** @deprecated — alias for `window`, retained for backward compatibility */
  @ApiPropertyOptional({
    description: 'Deprecated alias for `window`',
    enum: ['24h', '7d', '30d']
  })
  @IsOptional()
  @IsIn(['24h', '7d', '30d'])
  range?: '24h' | '7d' | '30d';

  @ApiPropertyOptional({ description: 'Explicit start timestamp (ISO-8601); overrides `window`' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Explicit end timestamp (ISO-8601); defaults to now' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ description: 'Filter by scenario reference (e.g. fraud-detection@1.2.0)' })
  @IsOptional()
  @IsString()
  scenarioRef?: string;

  @ApiPropertyOptional({ description: 'Filter by environment tag' })
  @IsOptional()
  @IsString()
  environment?: string;
}

export class DashboardKpisDto {
  @ApiProperty() totalRuns!: number;
  @ApiProperty() activeRuns!: number;
  @ApiProperty() completedRuns!: number;
  @ApiProperty() failedRuns!: number;
  @ApiProperty() cancelledRuns!: number;
  @ApiProperty() totalSignals!: number;
  @ApiProperty() totalTokens!: number;
  @ApiProperty() totalCostUsd!: number;
  @ApiPropertyOptional() avgDurationMs?: number;
}

export class ChartSeriesDto {
  @ApiProperty({ type: [String] }) labels!: string[];
  @ApiProperty({ type: [Number] }) data!: number[];
}

export class DashboardChartsDto {
  @ApiProperty() runVolume!: ChartSeriesDto;
  @ApiProperty() latency!: ChartSeriesDto;
  @ApiProperty() signalVolume!: ChartSeriesDto;
  @ApiProperty() errorClasses!: ChartSeriesDto;
  @ApiPropertyOptional() throughput?: ChartSeriesDto;
  @ApiPropertyOptional() queueDepth?: ChartSeriesDto;
  @ApiPropertyOptional() latencyP50?: ChartSeriesDto;
  @ApiPropertyOptional() latencyP95?: ChartSeriesDto;
  @ApiPropertyOptional() latencyP99?: ChartSeriesDto;
  @ApiPropertyOptional() cost?: ChartSeriesDto;
  @ApiPropertyOptional() successRate?: ChartSeriesDto;
  @ApiPropertyOptional() decisionOutcome?: ChartSeriesDto;
  @ApiPropertyOptional() perScenario?: ChartSeriesDto;
}

export class DashboardRunSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() status!: string;
  @ApiProperty() runtimeKind!: string;
  @ApiPropertyOptional() sourceRef?: string;
  @ApiPropertyOptional() startedAt?: string;
  @ApiPropertyOptional() endedAt?: string;
  @ApiProperty() createdAt!: string;
}

export class RuntimeHealthSummaryDto {
  @ApiProperty() ok!: boolean;
  @ApiProperty() runtimeKind!: string;
  @ApiPropertyOptional() detail?: string;
}

export class DashboardOverviewDto {
  @ApiProperty() kpis!: DashboardKpisDto;
  @ApiProperty({ type: [DashboardRunSummaryDto] }) recentRuns!: DashboardRunSummaryDto[];
  @ApiProperty() runtimeHealth!: RuntimeHealthSummaryDto;
  @ApiProperty() charts!: DashboardChartsDto;
}
