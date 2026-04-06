import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

export class DashboardOverviewQueryDto {
  @ApiPropertyOptional({
    description: 'Time range for dashboard data',
    enum: ['24h', '7d', '30d'],
    default: '24h'
  })
  @IsOptional()
  @IsIn(['24h', '7d', '30d'])
  range?: '24h' | '7d' | '30d';
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
