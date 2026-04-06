import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
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
import { ExecutionRequest } from '../contracts/control-plane';

export class RootRefDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  uri!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;
}

export class ParticipantRefDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  id!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  role?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  transportIdentity?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class ProtoPayloadDto {
  @ApiProperty({ description: 'Fully qualified protobuf message name.' })
  @IsString()
  @IsNotEmpty()
  typeName!: string;

  @ApiProperty({ type: 'object', additionalProperties: true })
  @IsObject()
  value!: Record<string, unknown>;
}

export class PayloadEnvelopeDto {
  @ApiProperty({ enum: ['json', 'text', 'base64', 'proto'] })
  @IsIn(['json', 'text', 'base64', 'proto'])
  encoding!: 'json' | 'text' | 'base64' | 'proto';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  mediaType?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  json?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  text?: string;

  @ApiPropertyOptional({ description: 'Opaque payload already base64-encoded.' })
  @IsOptional()
  @IsString()
  base64?: string;

  @ApiPropertyOptional({ type: () => ProtoPayloadDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ProtoPayloadDto)
  proto?: ProtoPayloadDto;
}

export class KickoffMessageDto {
  @ApiProperty()
  @IsString()
  from!: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  to!: string[];

  @ApiProperty({ enum: ['request', 'broadcast', 'proposal', 'context'] })
  @IsIn(['request', 'broadcast', 'proposal', 'context'])
  kind!: 'request' | 'broadcast' | 'proposal' | 'context';

  @ApiProperty({ description: 'Exact runtime MACP message type to send.' })
  @IsString()
  @IsNotEmpty()
  messageType!: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  @ApiPropertyOptional({ type: () => PayloadEnvelopeDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PayloadEnvelopeDto)
  payloadEnvelope?: PayloadEnvelopeDto;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
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

  @ApiPropertyOptional({ description: 'Sender used for SessionStart if provided.' })
  @IsOptional()
  @IsString()
  initiatorParticipantId?: string;

  @ApiProperty({ type: () => [ParticipantRefDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ParticipantRefDto)
  participants!: ParticipantRefDto[];

  @ApiPropertyOptional({ type: () => [RootRefDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RootRefDto)
  roots?: RootRefDto[];

  @ApiPropertyOptional({ description: 'Convenience JSON context; will be JSON-encoded to bytes.' })
  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;

  @ApiPropertyOptional({ type: () => PayloadEnvelopeDto, description: 'Binary/protobuf context override.' })
  @IsOptional()
  @ValidateNested()
  @Type(() => PayloadEnvelopeDto)
  contextEnvelope?: PayloadEnvelopeDto;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
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

export class ExecutionRequestDto implements ExecutionRequest {
  @ApiProperty({ enum: ['live', 'replay', 'sandbox'] })
  @IsIn(['live', 'replay', 'sandbox'])
  mode!: 'live' | 'replay' | 'sandbox';

  @ApiProperty({ type: () => RuntimeSelectionDto })
  @ValidateNested()
  @Type(() => RuntimeSelectionDto)
  runtime!: RuntimeSelectionDto;

  @ApiProperty({ type: () => SessionDescriptorDto })
  @ValidateNested()
  @Type(() => SessionDescriptorDto)
  session!: SessionDescriptorDto;

  @ApiPropertyOptional({ type: () => [KickoffMessageDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => KickoffMessageDto)
  kickoff?: KickoffMessageDto[];

  @ApiPropertyOptional({ type: () => ExecutionConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ExecutionConfigDto)
  execution?: ExecutionConfigDto;
}
