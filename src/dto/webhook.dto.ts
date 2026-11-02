import { IsArray, IsNotEmpty, IsOptional, IsString, IsUrl, Matches } from 'class-validator';
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
  // #143: an empty key makes the HMAC signature computable by anyone.
  @IsNotEmpty()
  @Matches(/\S/, { message: 'secret must not be blank' })
  secret!: string;
}
