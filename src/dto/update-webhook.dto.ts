import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsNotEmpty, IsOptional, IsString, IsUrl, Matches, ValidateIf } from 'class-validator';

export class UpdateWebhookDto {
  @ApiPropertyOptional({ description: 'Webhook delivery URL' })
  @IsOptional()
  @IsUrl()
  url?: string;

  @ApiPropertyOptional({ description: 'Event types to subscribe to', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  events?: string[];

  @ApiPropertyOptional({
    description: 'HMAC-SHA256 signing secret. Write-only: never returned; responses carry `hasSecret` instead.',
    writeOnly: true
  })
  // #145: `@IsOptional` would also skip validation for `null`, letting
  // `{"secret": null}` reach the NOT NULL column (500). Only an absent key skips.
  @ValidateIf((o: UpdateWebhookDto) => o.secret !== undefined)
  @IsString()
  // #143: when present, the secret must be non-blank (an empty HMAC key is forgeable).
  @IsNotEmpty()
  @Matches(/\S/, { message: 'secret must not be blank' })
  secret?: string;

  @ApiPropertyOptional({ description: 'Enable or disable the webhook' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
