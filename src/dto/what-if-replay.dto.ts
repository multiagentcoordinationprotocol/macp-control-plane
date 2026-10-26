import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDefined, IsIn, IsNotEmpty, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';
import { POLICY_SCHEMA_VERSIONS } from '../contracts/runtime';

export class WhatIfCandidateDto {
  @ApiPropertyOptional({
    description: "Policy mode. Defaults to the run's session mode; `*` replays a wildcard policy.",
    example: 'macp.mode.decision.v1'
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  mode?: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Candidate rules, the same shape `POST /runtime/policies` accepts. Never registered.'
  })
  @IsDefined()
  @IsObject()
  rules!: Record<string, unknown>;

  @ApiPropertyOptional({ enum: POLICY_SCHEMA_VERSIONS, default: 3 })
  @IsOptional()
  @IsIn([...POLICY_SCHEMA_VERSIONS])
  schemaVersion?: number;

  @ApiPropertyOptional({ description: 'Echoed back as `candidatePolicyId`; need not be registered.' })
  @IsOptional()
  @IsString()
  policyId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;
}

export class WhatIfReplayRequestDto {
  @ApiProperty({ type: () => WhatIfCandidateDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => WhatIfCandidateDto)
  candidate!: WhatIfCandidateDto;
}
