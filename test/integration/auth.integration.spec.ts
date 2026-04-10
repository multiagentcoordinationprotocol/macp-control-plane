import { createTestApp, TestAppContext } from '../helpers/test-app';
import { TestClient } from '../helpers/test-client';

describe('Authentication (integration)', () => {
  let ctx: TestAppContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await ctx.cleanup();
  });

  it('request without auth header returns 401', async () => {
    const noAuthClient = new TestClient(ctx.url);
    const res = await noAuthClient.requestNoAuth('GET', '/runs');
    expect(res.status).toBe(401);
  });

  it('request with invalid API key returns 401', async () => {
    const badClient = new TestClient(ctx.url, 'invalid-key');
    const res = await badClient.requestNoAuth('GET', '/runs', {
      headers: { Authorization: 'Bearer invalid-key' }
    });
    expect(res.status).toBe(401);
  });

  it('request with valid API key returns 200', async () => {
    const res = await ctx.client.requestNoAuth('GET', '/runs?limit=10&offset=0', {
      headers: { Authorization: 'Bearer test-key-integration' }
    });
    expect(res.status).toBe(200);
  });

  it('public endpoints are accessible without auth', async () => {
    const noAuthClient = new TestClient(ctx.url);

    const healthRes = await noAuthClient.requestNoAuth('GET', '/healthz');
    expect(healthRes.status).toBe(200);

    const readyRes = await noAuthClient.requestNoAuth('GET', '/readyz');
    expect(readyRes.status).toBe(200);

    const metricsRes = await noAuthClient.requestNoAuth('GET', '/metrics');
    expect(metricsRes.status).toBe(200);
  });
});
