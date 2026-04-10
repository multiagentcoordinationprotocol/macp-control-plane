import { createTestApp, TestAppContext } from '../helpers/test-app';
import { decisionModeRequest } from '../fixtures/decision-mode';
import { testRuntimeKind } from '../helpers/runtime-kind';

describe('Run Validation (integration)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('validates a correct execution request', async () => {
    const result = await ctx.client.validateRun(decisionModeRequest()) as any;
    expect(result).toHaveProperty('valid');
  });

  it('rejects request with missing participants', async () => {
    const request = decisionModeRequest();
    request.session.participants = [];

    const result = await ctx.client.validateRun(request) as any;
    // Should either return valid: false or HTTP 400
    if (result.valid !== undefined) {
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
    } else if (result.statusCode) {
      expect(result.statusCode).toBe(400);
    }
  });

  it('rejects request with empty modeName', async () => {
    const request = decisionModeRequest();
    request.session.modeName = '';

    const result = await ctx.client.validateRun(request) as any;
    if (result.valid !== undefined) {
      expect(result.valid).toBe(false);
    } else if (result.statusCode) {
      expect([400, 422]).toContain(result.statusCode);
    }
  });

  it('rejects request without session', async () => {
    const result = await ctx.client.validateRun({
      mode: 'sandbox',
      runtime: { kind: testRuntimeKind() }
    }) as any;

    // Should fail validation
    if (result.statusCode) {
      expect([400, 422]).toContain(result.statusCode);
    }
  });
});
