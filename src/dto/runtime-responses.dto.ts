import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RuntimeManifestResultDto {
  @ApiProperty() agentId!: string;
  @ApiPropertyOptional() title?: string;
  @ApiPropertyOptional() description?: string;
  @ApiProperty({ type: [String] }) supportedModes!: string[];
  @ApiPropertyOptional() metadata?: Record<string, string>;
}

export class RuntimeModeDescriptorDto {
  @ApiProperty() mode!: string;
  @ApiProperty() modeVersion!: string;
  @ApiPropertyOptional() title?: string;
  @ApiPropertyOptional() description?: string;
  @ApiPropertyOptional() determinismClass?: string;
  @ApiPropertyOptional() participantModel?: string;
  @ApiProperty({ type: [String] }) messageTypes!: string[];
  @ApiProperty({ type: [String] }) terminalMessageTypes!: string[];
  @ApiPropertyOptional() schemaUris?: Record<string, string>;
}

export class RuntimeRootDescriptorDto {
  @ApiProperty() uri!: string;
  @ApiPropertyOptional() name?: string;
}

export class RuntimePolicyDescriptorDto {
  @ApiProperty() policyId!: string;
  @ApiProperty() mode!: string;
  @ApiProperty() description!: string;
  @ApiProperty({
    description:
      'Parsed policy rules object (RFC-MACP-0012 per-mode schema: voting, objection_handling, evaluation, commitment for decision; threshold, abstention, commitment for quorum; etc.)'
  })
  rules!: Record<string, unknown>;
  @ApiProperty() schemaVersion!: number;
  @ApiPropertyOptional() registeredAtUnixMs?: number;
}

export class RuntimeRegisterPolicyResultDto {
  @ApiProperty() ok!: boolean;
  @ApiPropertyOptional() error?: string;
}

export class RuntimeUnregisterPolicyResultDto {
  @ApiProperty() ok!: boolean;
  @ApiPropertyOptional() error?: string;
}
