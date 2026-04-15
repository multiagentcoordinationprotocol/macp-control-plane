import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsString, Min } from 'class-validator';

export class ListEventsQueryDto {
  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === null) ? undefined : Number(value))
  @IsInt()
  @Min(0)
  afterSeq?: number;

  @ApiPropertyOptional({ minimum: 1, default: 200 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined || value === null) ? undefined : Number(value))
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({ description: 'ISO-8601 timestamp — return events with ts strictly greater' })
  @IsOptional()
  @IsISO8601()
  afterTs?: string;

  @ApiPropertyOptional({ description: 'ISO-8601 timestamp — return events with ts strictly less' })
  @IsOptional()
  @IsISO8601()
  beforeTs?: string;

  @ApiPropertyOptional({ description: 'Comma-separated canonical event types to filter (e.g. signal.emitted,signal.acknowledged)' })
  @IsOptional()
  @IsString()
  type?: string;
}

export class ListCrossRunEventsQueryDto extends ListEventsQueryDto {
  @ApiPropertyOptional({ description: 'Filter by scenario reference (source_ref or metadata.scenarioRef ILIKE)' })
  @IsOptional()
  @IsString()
  scenarioRef?: string;

  @ApiPropertyOptional({ description: 'Filter by run ID' })
  @IsOptional()
  @IsString()
  runId?: string;
}
