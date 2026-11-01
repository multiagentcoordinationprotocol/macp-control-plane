import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  ValidationPipe
} from '@nestjs/common';
import {
  ApiBody,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags
} from '@nestjs/swagger';
import { CreateWebhookDto } from '../dto/webhook.dto';
import { UpdateWebhookDto } from '../dto/update-webhook.dto';
import { WebhookService } from '../webhooks/webhook.service';
import { arrayOf, ref } from '../openapi/schemas';

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  @Post()
  @ApiOperation({ summary: 'Register a new webhook subscription.' })
  @ApiBody({ type: CreateWebhookDto })
  @ApiCreatedResponse({ schema: ref('WebhookRecord') })
  async createWebhook(
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) body: CreateWebhookDto
  ) {
    return this.webhookService.register({
      url: body.url,
      events: body.events ?? [],
      secret: body.secret
    });
  }

  @Get()
  @ApiOperation({ summary: 'List all webhook subscriptions.' })
  @ApiOkResponse({ schema: arrayOf('WebhookRecord') })
  async listWebhooks() {
    return this.webhookService.list();
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a webhook subscription (URL, events, active toggle).' })
  @ApiBody({ type: UpdateWebhookDto })
  @ApiOkResponse({
    description: 'The updated subscription; an empty body when the id is unknown.',
    schema: ref('WebhookRecord')
  })
  async updateWebhook(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) body: UpdateWebhookDto
  ) {
    return this.webhookService.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a webhook subscription.' })
  @ApiNoContentResponse({ description: 'Removed (also when the id is unknown).' })
  async deleteWebhook(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.webhookService.remove(id);
  }
}
