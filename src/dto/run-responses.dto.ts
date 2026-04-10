import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CanonicalEvent, MetricsSummary, RunComparisonResult, RunExportBundle, RunStateProjection, RunStatus } from '../contracts/control-plane';

export class CreateRunResponseDto {
  @ApiProperty()
  runId!: string;

  @ApiProperty({ enum: ['queued', 'starting', 'binding_session', 'running', 'completed', 'failed', 'cancelled'] })
  status!: RunStatus;

  @ApiPropertyOptional()
  traceId?: string;
}

export class RuntimeHealthResponseDto {
  @ApiProperty()
  ok!: boolean;

  @ApiProperty()
  runtimeKind!: string;

  @ApiPropertyOptional()
  detail?: string;
}

export class ReplayDescriptorDto {
  @ApiProperty()
  runId!: string;

  @ApiProperty()
  mode!: string;

  @ApiProperty()
  speed!: number;

  @ApiPropertyOptional()
  fromSeq?: number;

  @ApiPropertyOptional()
  toSeq?: number;

  @ApiProperty()
  streamUrl!: string;

  @ApiProperty()
  stateUrl!: string;
}

export class RunStateResponseDto implements RunStateProjection {
  @ApiProperty({ type: 'object', additionalProperties: true })
  run!: RunStateProjection['run'];

  @ApiProperty({ type: 'array', items: { type: 'object', additionalProperties: true } })
  participants!: RunStateProjection['participants'];

  @ApiProperty({ type: 'object', additionalProperties: true })
  graph!: RunStateProjection['graph'];

  @ApiProperty({ type: 'object', additionalProperties: true })
  decision!: RunStateProjection['decision'];

  @ApiProperty({ type: 'object', additionalProperties: true })
  signals!: RunStateProjection['signals'];

  @ApiProperty({ type: 'object', additionalProperties: true })
  progress!: RunStateProjection['progress'];

  @ApiProperty({ type: 'object', additionalProperties: true })
  timeline!: RunStateProjection['timeline'];

  @ApiProperty({ type: 'object', additionalProperties: true })
  trace!: RunStateProjection['trace'];

  @ApiProperty({ type: 'object', additionalProperties: true })
  outboundMessages!: RunStateProjection['outboundMessages'];

  @ApiProperty({ type: 'object', additionalProperties: true })
  policy!: RunStateProjection['policy'];
}

export class MetricsSummaryDto implements MetricsSummary {
  @ApiProperty()
  runId!: string;

  @ApiProperty()
  eventCount!: number;

  @ApiProperty()
  messageCount!: number;

  @ApiProperty()
  signalCount!: number;

  @ApiProperty()
  proposalCount!: number;

  @ApiProperty()
  toolCallCount!: number;

  @ApiProperty()
  decisionCount!: number;

  @ApiProperty()
  streamReconnectCount!: number;

  @ApiProperty()
  promptTokens!: number;

  @ApiProperty()
  completionTokens!: number;

  @ApiProperty()
  totalTokens!: number;

  @ApiProperty()
  estimatedCostUsd!: number;

  @ApiPropertyOptional()
  firstEventAt?: string;

  @ApiPropertyOptional()
  lastEventAt?: string;

  @ApiPropertyOptional()
  durationMs?: number;

  @ApiPropertyOptional()
  sessionState?: MetricsSummary['sessionState'];
}

export class CanonicalEventDto implements CanonicalEvent {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  runId!: string;

  @ApiProperty()
  seq!: number;

  @ApiProperty()
  ts!: string;

  @ApiProperty()
  type!: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  subject?: CanonicalEvent['subject'];

  @ApiProperty({ type: 'object', additionalProperties: true })
  source!: CanonicalEvent['source'];

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  trace?: CanonicalEvent['trace'];

  @ApiProperty({ type: 'object', additionalProperties: true })
  data!: Record<string, unknown>;
}

export class RunBundleExportDto implements RunExportBundle {
  @ApiProperty({ type: 'object', additionalProperties: true })
  run!: RunExportBundle['run'];

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  session!: RunExportBundle['session'];

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  projection!: RunExportBundle['projection'];

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  metrics!: RunExportBundle['metrics'];

  @ApiProperty({ type: 'array', items: { type: 'object', additionalProperties: true } })
  artifacts!: RunExportBundle['artifacts'];

  @ApiProperty({ type: 'array', items: { type: 'object', additionalProperties: true } })
  canonicalEvents!: RunExportBundle['canonicalEvents'];

  @ApiProperty({ type: 'array', items: { type: 'object', additionalProperties: true } })
  rawEvents!: RunExportBundle['rawEvents'];

  @ApiProperty()
  exportedAt!: string;
}

export class RunComparisonResultDto implements RunComparisonResult {
  @ApiProperty({ type: 'object', additionalProperties: true })
  left!: RunComparisonResult['left'];

  @ApiProperty({ type: 'object', additionalProperties: true })
  right!: RunComparisonResult['right'];

  @ApiProperty()
  statusMatch!: boolean;

  @ApiPropertyOptional()
  durationDeltaMs?: number;

  @ApiPropertyOptional()
  confidenceDelta?: number;

  @ApiProperty({ type: 'object', additionalProperties: true })
  participantsDiff!: RunComparisonResult['participantsDiff'];

  @ApiProperty({ type: 'object', additionalProperties: true })
  signalsDiff!: RunComparisonResult['signalsDiff'];
}
