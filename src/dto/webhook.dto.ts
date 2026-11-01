import { IsArray, IsOptional, IsString, IsUrl } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateWebhookDto {
  @ApiProperty({ description: 'URL to receive webhook POST requests' })
  @IsUrl()
  url!: string;

  @ApiPropertyOptional({ description: 'Events to subscribe to. Empty = all events.', default: [] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  events?: string[];

  @ApiProperty({
    description:
      'Secret used for HMAC-SHA256 signature verification. Write-only: never returned; responses carry `hasSecret` instead.',
    writeOnly: true
  })
  @IsString()
  secret!: string;
}
