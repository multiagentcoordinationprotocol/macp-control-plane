import { RuntimeCredentialResolverService } from './runtime-credential-resolver.service';
import { AppConfigService } from '../config/app-config.service';

describe('RuntimeCredentialResolverService (single-bearer, CP-9)', () => {
  function makeService(config: Partial<AppConfigService>): RuntimeCredentialResolverService {
    const merged = {
      runtimeDevAgentId: 'control-plane',
      runtimeBearerToken: '',
      runtimeUseDevHeader: false,
      ...config,
    } as AppConfigService;
    return new RuntimeCredentialResolverService(merged);
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
        runtimeUseDevHeader: true,
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
        runtimeDevAgentId: 'control-plane',
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

  describe('invariant — no per-sender overrides (direct-agent-auth §Invariants)', () => {
    it('ignores any extra fields in the request (participant, requester, fallbackSender)', async () => {
      const service = makeService({ runtimeBearerToken: 'obs-token' });
      const result = await service.resolve({
        runtimeKind: 'rust',
        // Cast — these fields are no longer accepted, but the resolver must tolerate them
        // during the deprecation window without routing on them.
        ...( { participant: { id: 'risk-agent' }, requester: { actorId: 'user-1' } } as unknown as Record<string, unknown>),
      } as { runtimeKind: string });
      expect(result.metadata.authorization).toBe('Bearer obs-token');
      expect(result.sender).toBe('control-plane');
    });
  });
});
