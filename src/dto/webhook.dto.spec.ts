import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreateWebhookDto } from './webhook.dto';
import { UpdateWebhookDto } from './update-webhook.dto';

// The same pipe options the webhook controller applies to its bodies.
const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
const meta = (metatype: ArgumentMetadata['metatype']): ArgumentMetadata => ({ type: 'body', metatype, data: '' });
const validate = (metatype: ArgumentMetadata['metatype'], body: unknown) => pipe.transform(body, meta(metatype));

// #143: an empty HMAC key makes every delivery signature computable by anyone.
describe('webhook DTOs reject a blank signing secret (#143)', () => {
  const url = 'https://example.com/hook';

  describe('CreateWebhookDto', () => {
    it.each([
      ['an empty', ''],
      ['a whitespace-only', ' \t\n ']
    ])('rejects %s secret with 400', async (_label, secret) => {
      await expect(validate(CreateWebhookDto, { url, secret })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('still rejects a missing secret', async () => {
      await expect(validate(CreateWebhookDto, { url })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a valid secret', async () => {
      await expect(validate(CreateWebhookDto, { url, secret: 's3cret' })).resolves.toMatchObject({ url });
    });

    it('accepts a secret with surrounding whitespace (no trimming, no minimum length)', async () => {
      await expect(validate(CreateWebhookDto, { url, secret: ' k ' })).resolves.toBeInstanceOf(CreateWebhookDto);
    });
  });

  describe('UpdateWebhookDto', () => {
    it.each([
      ['an empty', ''],
      ['a whitespace-only', '   ']
    ])('rejects %s secret with 400', async (_label, secret) => {
      await expect(validate(UpdateWebhookDto, { secret })).rejects.toBeInstanceOf(BadRequestException);
    });

    // #145: `{"secret": null}` used to skip validation and hit the NOT NULL column (500).
    it('rejects a null secret with 400', async () => {
      await expect(validate(UpdateWebhookDto, { secret: null })).rejects.toBeInstanceOf(BadRequestException);
    });

    // #147: the same 500 for the other optional fields.
    it.each(['url', 'events', 'active'])('rejects a null %s with 400', async (field) => {
      await expect(validate(UpdateWebhookDto, { [field]: null })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts an update without a secret', async () => {
      await expect(validate(UpdateWebhookDto, { active: false })).resolves.toMatchObject({ active: false });
    });

    it('accepts an update with a valid secret', async () => {
      await expect(validate(UpdateWebhookDto, { secret: 'rotated' })).resolves.toBeInstanceOf(UpdateWebhookDto);
    });
  });
});
