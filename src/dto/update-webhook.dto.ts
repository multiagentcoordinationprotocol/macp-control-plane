import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsNotEmpty, IsString, IsUrl, Matches, ValidateIf } from 'class-validator';

// `@IsOptional` also skips validation for `null`, letting e.g. `{"url": null}`
// reach the update and fail there (500). Only an absent key may skip (#145, #147).
const presentIn =
  <K extends keyof UpdateWebhookDto>(key: K) =>
  (o: UpdateWebhookDto) =>
    o[key] !== undefined;

export class UpdateWebhookDto {
  @ApiPropertyOptional({ description: 'Webhook delivery URL' })
  @ValidateIf(presentIn('url'))
  @IsUrl()
  url?: string;

  @ApiPropertyOptional({ description: 'Event types to subscribe to', type: [String] })
  @ValidateIf(presentIn('events'))
  @IsArray()
  @IsString({ each: true })
  events?: string[];

  @ApiPropertyOptional({
    description: 'HMAC-SHA256 signing secret. Write-only: never returned; responses carry `hasSecret` instead.',
    writeOnly: true
  })
  @ValidateIf(presentIn('secret'))
  @IsString()
  // #143: when present, the secret must be non-blank (an empty HMAC key is forgeable).
  @IsNotEmpty()
  @Matches(/\S/, { message: 'secret must not be blank' })
  secret?: string;

  @ApiPropertyOptional({ description: 'Enable or disable the webhook' })
  @ValidateIf(presentIn('active'))
  @IsBoolean()
  active?: boolean;
}
