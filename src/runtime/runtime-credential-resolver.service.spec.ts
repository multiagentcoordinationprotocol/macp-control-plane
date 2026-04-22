import { RuntimeCredentialResolverService } from './runtime-credential-resolver.service';
import { RuntimeJwtMinterService } from './runtime-jwt-minter.service';
import { AppConfigService } from '../config/app-config.service';

describe('RuntimeCredentialResolverService (single-bearer, CP-9)', () => {
  function makeService(config: Partial<AppConfigService>): RuntimeCredentialResolverService {
    const merged = {
      runtimeDevAgentId: 'control-plane',
      runtimeBearerToken: '',
      runtimeUseDevHeader: false,
      ...config
    } as AppConfigService;
    // JWT minter disabled in these tests — auth-service URL is unset, so the
    // resolver exercises the static-bearer / dev-header paths.
    const jwtMinter = {
      isEnabled: () => false,
      getToken: () => Promise.reject(new Error('jwt disabled in unit test'))
    } as unknown as RuntimeJwtMinterService;
    return new RuntimeCredentialResolverService(merged, jwtMinter);
  }

  describe('sender identity', () => {
    it('always returns the control-plane dev agent id as sender', async () => {
      const service = makeService({ runtimeDevAgentId: 'my-control-plane' });
      const result = await service.resolve({ runtimeKind: 'rust' });
      expect(result.sender).toBe('my-control-plane');
    });

    it('defaults sender to "control-plane" when no dev agent id is configured', async () => {
      const service = makeService({});
      const result = await service.resolve({ runtimeKind: 'rust' });
      expect(result.sender).toBe('control-plane');
    });
  });

  describe('bearer token', () => {
    it('attaches the configured bearer token as Authorization', async () => {
      const service = makeService({ runtimeBearerToken: 'obs-token' });
      const result = await service.resolve({ runtimeKind: 'rust' });
      expect(result.metadata.authorization).toBe('Bearer obs-token');
    });

    it('does not attach an x-macp-agent-id header when a bearer token is present', async () => {
      const service = makeService({
        runtimeBearerToken: 'obs-token',
        runtimeUseDevHeader: true
      });
      const result = await service.resolve({ runtimeKind: 'rust' });
      expect(result.metadata['x-macp-agent-id']).toBeUndefined();
    });
  });

  describe('dev header fallback', () => {
    it('falls back to x-macp-agent-id when no bearer token and dev header is enabled', async () => {
      const service = makeService({
        runtimeBearerToken: '',
        runtimeUseDevHeader: true,
        runtimeDevAgentId: 'control-plane'
      });
      const result = await service.resolve({ runtimeKind: 'rust' });
      expect(result.metadata['x-macp-agent-id']).toBe('control-plane');
      expect(result.metadata.authorization).toBeUndefined();
    });
  });

  describe('no credentials configured', () => {
    it('returns empty metadata when neither bearer token nor dev header is enabled', async () => {
      const service = makeService({});
      const result = await service.resolve({ runtimeKind: 'rust' });
      expect(result.metadata).toEqual({});
    });
  });

  describe('JWT mint path', () => {
    it('uses the minted JWT as Authorization when the minter is enabled', async () => {
      const merged = {
        runtimeDevAgentId: 'control-plane',
        runtimeBearerToken: '',
        runtimeUseDevHeader: false
      } as AppConfigService;
      const jwtMinter = {
        isEnabled: () => true,
        getToken: jest.fn().mockResolvedValue('minted-jwt-token')
      } as unknown as RuntimeJwtMinterService;
      const service = new RuntimeCredentialResolverService(merged, jwtMinter);

      const result = await service.resolve({ runtimeKind: 'rust' });
      expect(result.metadata.authorization).toBe('Bearer minted-jwt-token');
    });

    it('falls back to static bearer when the mint rejects', async () => {
      const merged = {
        runtimeDevAgentId: 'control-plane',
        runtimeBearerToken: 'fallback-bearer',
        runtimeUseDevHeader: false
      } as AppConfigService;
      const jwtMinter = {
        isEnabled: () => true,
        getToken: jest.fn().mockRejectedValue(new Error('auth-service down'))
      } as unknown as RuntimeJwtMinterService;
      const service = new RuntimeCredentialResolverService(merged, jwtMinter);

      const result = await service.resolve({ runtimeKind: 'rust' });
      expect(result.metadata.authorization).toBe('Bearer fallback-bearer');
    });
  });

  describe('invariant — no per-sender overrides (direct-agent-auth §Invariants)', () => {
    it('ignores any extra fields in the request (participant, requester, fallbackSender)', async () => {
      const service = makeService({ runtimeBearerToken: 'obs-token' });
      const result = await service.resolve({
        runtimeKind: 'rust',
        // Cast — these fields are no longer accepted, but the resolver must tolerate them
        // during the deprecation window without routing on them.
        ...({ participant: { id: 'risk-agent' }, requester: { actorId: 'user-1' } } as unknown as Record<
          string,
          unknown
        >)
      } as { runtimeKind: string });
      expect(result.metadata.authorization).toBe('Bearer obs-token');
      expect(result.sender).toBe('control-plane');
    });
  });
});
