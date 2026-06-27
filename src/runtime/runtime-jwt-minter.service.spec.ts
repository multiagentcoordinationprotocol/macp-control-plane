import { RuntimeJwtMinterService } from './runtime-jwt-minter.service';
import { AppConfigService } from '../config/app-config.service';

type FetchMock = jest.Mock<Promise<Response>, [input: RequestInfo | URL, init?: RequestInit]>;

describe('RuntimeJwtMinterService', () => {
  const baseConfig = {
    authServiceUrl: 'https://auth.example/',
    authServiceTimeoutMs: 5000,
    authTokenSender: 'control-plane',
    authTokenTtlSeconds: 3600
  } as unknown as AppConfigService;

  const originalFetch = globalThis.fetch;
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = jest.fn() as unknown as FetchMock;
    (globalThis as { fetch: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = originalFetch;
    jest.useRealTimers();
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    });
  }

  describe('isEnabled()', () => {
    it('returns true when MACP_AUTH_SERVICE_URL is set', () => {
      const minter = new RuntimeJwtMinterService(baseConfig);
      expect(minter.isEnabled()).toBe(true);
    });

    it('returns false when MACP_AUTH_SERVICE_URL is empty', () => {
      const minter = new RuntimeJwtMinterService({
        ...baseConfig,
        authServiceUrl: ''
      } as unknown as AppConfigService);
      expect(minter.isEnabled()).toBe(false);
    });
  });

  describe('getToken()', () => {
    it('throws when minter is disabled', async () => {
      const minter = new RuntimeJwtMinterService({
        ...baseConfig,
        authServiceUrl: ''
      } as unknown as AppConfigService);
      await expect(minter.getToken()).rejects.toThrow(/MACP_AUTH_SERVICE_URL is unset/);
    });

    it('mints a token via auth-service and caches it across calls', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ token: 'jwt-1', sender: 'control-plane', expires_in_seconds: 3600 })
      );
      const minter = new RuntimeJwtMinterService(baseConfig);

      const first = await minter.getToken();
      const second = await minter.getToken();

      expect(first).toBe('jwt-1');
      expect(second).toBe('jwt-1');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe('https://auth.example/tokens');
      expect(init?.method).toBe('POST');
      const body = JSON.parse((init?.body as string) ?? '{}');
      expect(body.sender).toBe('control-plane');
      expect(body.scopes.is_observer).toBe(true);
      expect(body.scopes.can_start_sessions).toBe(false);
      // Registry management stays off unless explicitly opted in.
      expect(body.scopes.can_manage_mode_registry).toBeUndefined();
    });

    it('requests can_manage_mode_registry when the operator opts in', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ token: 'jwt-admin', sender: 'control-plane' }));
      const minter = new RuntimeJwtMinterService({
        ...baseConfig,
        authTokenCanManageRegistry: true
      } as unknown as AppConfigService);

      await minter.getToken();

      const [, init] = fetchMock.mock.calls[0];
      const body = JSON.parse((init?.body as string) ?? '{}');
      expect(body.scopes.can_manage_mode_registry).toBe(true);
      // Still not a session initiator.
      expect(body.scopes.can_start_sessions).toBe(false);
      expect(body.scopes.is_observer).toBe(true);
    });

    it('dedupes concurrent refreshes into a single inflight request', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ token: 'jwt-once', expires_in_seconds: 3600 }));
      const minter = new RuntimeJwtMinterService(baseConfig);

      const [a, b, c] = await Promise.all([minter.getToken(), minter.getToken(), minter.getToken()]);

      expect(a).toBe('jwt-once');
      expect(b).toBe('jwt-once');
      expect(c).toBe('jwt-once');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('throws when auth-service returns non-2xx', async () => {
      fetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
      const minter = new RuntimeJwtMinterService(baseConfig);
      await expect(minter.getToken()).rejects.toThrow(/auth-service returned 403/);
    });

    it('throws when the auth-service response is missing a token', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ sender: 'control-plane' }));
      const minter = new RuntimeJwtMinterService(baseConfig);
      await expect(minter.getToken()).rejects.toThrow(/missing token/);
    });

    it('wraps network failures with a descriptive error', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('connect ECONNREFUSED'));
      const minter = new RuntimeJwtMinterService(baseConfig);
      await expect(minter.getToken()).rejects.toThrow(/auth-service request failed/);
    });

    it('refreshes the cached token once it passes the refresh buffer', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ token: 'jwt-1', expires_in_seconds: 60 }))
        .mockResolvedValueOnce(jsonResponse({ token: 'jwt-2', expires_in_seconds: 60 }));

      const realNow = Date.now();
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(realNow);
      const minter = new RuntimeJwtMinterService(baseConfig);

      const first = await minter.getToken();
      expect(first).toBe('jwt-1');

      // Advance past expiry minus REFRESH_BUFFER (30s) minus CLOCK_SKEW (10s) — i.e.,
      // 60s TTL with 40s of buffer leaves a 20s window before forced refresh.
      nowSpy.mockReturnValue(realNow + 25_000);

      const second = await minter.getToken();
      expect(second).toBe('jwt-2');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
