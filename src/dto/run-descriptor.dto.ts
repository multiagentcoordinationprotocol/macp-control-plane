import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  ValidateNested
} from 'class-validator';
import { RunDescriptor } from '../contracts/control-plane';

/**
 * RunDescriptor DTO — scenario-agnostic. Rejects scenario-specific keys
 * via `forbidNonWhitelisted: true` at the controller level.
 *
 * See direct-agent-auth.md §Generic contracts for the contract invariants:
 * no kickoff[], no policyHints, no participants[].role, no commitments[],
 * no initiatorParticipantId.
 */

export class ParticipantRefDto {
  @ApiProperty({ description: 'Bare sender string — must match the agent identity in the runtime.' })
  @IsString()
  @IsNotEmpty()
  id!: string;
}

export class ExecutionRequesterDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  actorId?: string;

  @ApiPropertyOptional({ enum: ['user', 'service', 'system'] })
  @IsOptional()
  @IsIn(['user', 'service', 'system'])
  actorType?: 'user' | 'service' | 'system';
}

export class SessionDescriptorDto {
  @ApiPropertyOptional({
    description:
      'Caller-allocated session id. Must satisfy runtime validator (UUID v4/v7 or base64url 22+ chars). If omitted, control-plane allocates a UUID v4.'
  })
  @IsOptional()
  @IsString()
  sessionId?: string;

  @ApiProperty({ example: 'macp.mode.decision.v1' })
  @IsString()
  @IsNotEmpty()
  modeName!: string;

  @ApiProperty({ example: '1.0.0' })
  @IsString()
  modeVersion!: string;

  @ApiProperty({ example: 'config.default' })
  @IsString()
  configurationVersion!: string;

  @ApiPropertyOptional({ example: 'policy.default' })
  @IsOptional()
  @IsString()
  policyVersion?: string;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @IsPositive()
  ttlMs!: number;

  @ApiProperty({ type: () => [ParticipantRefDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000, { message: 'Maximum 1000 participants per session' })
  @ValidateNested({ each: true })
  @Type(() => ParticipantRefDto)
  participants!: ParticipantRefDto[];

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description:
      'Opaque metadata. Reserved keys: source, sourceRef, environment, scenarioRef, cancelCallback, cancellationDelegated.'
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class ExecutionConfigDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  idempotencyKey?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ type: () => ExecutionRequesterDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ExecutionRequesterDto)
  requester?: ExecutionRequesterDto;
}

export class RuntimeSelectionDto {
  @ApiProperty({ example: 'rust' })
  @IsString()
  kind!: string;

  @ApiPropertyOptional({ example: 'v1' })
  @IsOptional()
  @IsString()
  version?: string;
}

export class RunDescriptorDto implements RunDescriptor {
  @ApiProperty({ enum: ['live', 'sandbox'] })
  @IsIn(['live', 'sandbox'])
  mode!: 'live' | 'sandbox';

  @ApiProperty({ type: () => RuntimeSelectionDto })
  @ValidateNested()
  @Type(() => RuntimeSelectionDto)
  runtime!: RuntimeSelectionDto;

  @ApiProperty({ type: () => SessionDescriptorDto })
  @ValidateNested()
  @Type(() => SessionDescriptorDto)
  session!: SessionDescriptorDto;

  @ApiPropertyOptional({ type: () => ExecutionConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ExecutionConfigDto)
  execution?: ExecutionConfigDto;
}
