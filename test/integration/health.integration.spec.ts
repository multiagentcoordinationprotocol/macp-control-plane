import { createTestApp, TestAppContext } from '../helpers/test-app';
import { TestClient } from '../helpers/test-client';

describe('Health Probes (integration)', () => {
  let ctx: TestAppContext;
  let client: TestClient;

  beforeAll(async () => {
    ctx = await createTestApp();
    client = ctx.client;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  it('GET /healthz returns 200 with ok=true', async () => {
    const result = await client.healthz() as Record<string, unknown>;
    expect(result).toHaveProperty('ok', true);
    expect(result).toHaveProperty('service', 'macp-control-plane');
  });

  it('GET /readyz returns 200 with subsystem statuses', async () => {
    const result = await client.readyz() as Record<string, unknown>;
    expect(result).toHaveProperty('ok');
    expect(result).toHaveProperty('database');
    expect(result).toHaveProperty('runtime');
    expect(result).toHaveProperty('streamConsumer');
    expect(result).toHaveProperty('circuitBreaker');
  });

  it('GET /metrics returns Prometheus text format', async () => {
    const result = await client.metrics();
    expect(typeof result).toBe('string');
    expect(result).toContain('process_cpu');
  });

  it('health endpoints are accessible without auth', async () => {
    const noAuthClient = new TestClient(ctx.url);

    const healthRes = await noAuthClient.requestNoAuth('GET', '/healthz');
    expect(healthRes.status).toBe(200);

    const readyRes = await noAuthClient.requestNoAuth('GET', '/readyz');
    expect(readyRes.status).toBe(200);

    const metricsRes = await noAuthClient.requestNoAuth('GET', '/metrics');
    expect(metricsRes.status).toBe(200);
  });
});
