import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

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
}
