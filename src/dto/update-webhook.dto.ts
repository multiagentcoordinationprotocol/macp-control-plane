import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsOptional, IsString, IsUrl } from 'class-validator';

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
  @IsOptional()
  @IsString()
  secret?: string;

  @ApiPropertyOptional({ description: 'Enable or disable the webhook' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
