import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { RunStatus } from '../contracts/control-plane';

export class ListRunsQueryDto {
  @ApiPropertyOptional({ enum: ['queued', 'starting', 'binding_session', 'running', 'completed', 'failed', 'cancelled'] })
  @IsOptional()
  @IsIn(['queued', 'starting', 'binding_session', 'running', 'completed', 'failed', 'cancelled'])
  status?: RunStatus;

  @ApiPropertyOptional({ type: [String], description: 'Filter by tags (comma-separated)' })
  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.split(',').map((s: string) => s.trim()) : value)
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ description: 'Filter runs created after this ISO date' })
  @IsOptional()
  @IsString()
  createdAfter?: string;

  @ApiPropertyOptional({ description: 'Filter runs created before this ISO date' })
  @IsOptional()
  @IsString()
  createdBefore?: string;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(0)
  offset?: number;

  @ApiPropertyOptional({ enum: ['createdAt', 'updatedAt'], default: 'createdAt' })
  @IsOptional()
  @IsIn(['createdAt', 'updatedAt'])
  sortBy?: 'createdAt' | 'updatedAt';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';

  @ApiPropertyOptional({ description: 'Include archived runs in listing', default: false })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  includeArchived?: boolean;

  @ApiPropertyOptional({ description: 'Filter by environment (from run metadata)' })
  @IsOptional()
  @IsString()
  environment?: string;

  @ApiPropertyOptional({ description: 'Filter by scenario ref (from run metadata, supports partial match)' })
  @IsOptional()
  @IsString()
  scenarioRef?: string;

  @ApiPropertyOptional({ description: 'Search across run ID, tags, scenario ref, environment' })
  @IsOptional()
  @IsString()
  search?: string;
}
