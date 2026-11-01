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
import { toWebhookView, type WebhookView } from '../webhooks/webhook-view';
import { arrayOf, ref } from '../openapi/schemas';

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  @Post()
  @ApiOperation({ summary: 'Register a new webhook subscription.' })
  @ApiBody({ type: CreateWebhookDto })
  @ApiCreatedResponse({ schema: ref('WebhookView') })
  async createWebhook(
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) body: CreateWebhookDto
  ): Promise<WebhookView | null> {
    const row = await this.webhookService.register({
      url: body.url,
      events: body.events ?? [],
      secret: body.secret
    });
    return row ? toWebhookView(row) : null;
  }

  @Get()
  @ApiOperation({ summary: 'List all webhook subscriptions.' })
  @ApiOkResponse({ schema: arrayOf('WebhookView') })
  async listWebhooks(): Promise<WebhookView[]> {
    const rows = await this.webhookService.list();
    return rows.map(toWebhookView);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a webhook subscription (URL, events, active toggle).' })
  @ApiBody({ type: UpdateWebhookDto })
  @ApiOkResponse({
    description: 'The updated subscription; an empty body when the id is unknown.',
    schema: { allOf: [ref('WebhookView')], nullable: true }
  })
  async updateWebhook(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) body: UpdateWebhookDto
  ): Promise<WebhookView | null> {
    const row = await this.webhookService.update(id, body);
    return row ? toWebhookView(row) : null;
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a webhook subscription.' })
  @ApiNoContentResponse({ description: 'Removed (also when the id is unknown).' })
  async deleteWebhook(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.webhookService.remove(id);
  }
}
