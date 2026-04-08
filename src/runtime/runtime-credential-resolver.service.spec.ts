import { RuntimeCredentialResolverService } from './runtime-credential-resolver.service';
import { AppConfigService } from '../config/app-config.service';

describe('RuntimeCredentialResolverService', () => {
  let service: RuntimeCredentialResolverService;
  let mockConfig: Partial<AppConfigService>;

  function buildConfig(overrides: Partial<AppConfigService> = {}): AppConfigService {
    return {
      runtimeDevAgentId: 'control-plane',
      runtimeBearerToken: '',
      runtimeUseDevHeader: false,
      ...overrides,
    } as AppConfigService;
  }

  beforeEach(() => {
    mockConfig = buildConfig();
    service = new RuntimeCredentialResolverService(mockConfig as AppConfigService);
  });

  // ===========================================================================
  // Sender resolution priority
  // ===========================================================================
  describe('sender resolution', () => {
    it('uses participant.transportIdentity as highest priority', async () => {
      const result = await service.resolve({
        runtimeKind: 'rust',
        requester: { actorId: 'actor-1' },
        participant: { id: 'part-1', transportIdentity: 'transport-id' },
        fallbackSender: 'fallback',
      });

      expect(result.sender).toBe('transport-id');
    });

    it('falls back to participant.id when transportIdentity is absent', async () => {
      const result = await service.resolve({
        runtimeKind: 'rust',
        requester: { actorId: 'actor-1' },
        participant: { id: 'part-1' },
        fallbackSender: 'fallback',
      });

      expect(result.sender).toBe('part-1');
    });

    it('falls back to requester.actorId when no participant', async () => {
      const result = await service.resolve({
        runtimeKind: 'rust',
        requester: { actorId: 'actor-1' },
        fallbackSender: 'fallback',
      });

      expect(result.sender).toBe('actor-1');
    });

    it('falls back to fallbackSender when no participant or requester actorId', async () => {
      const result = await service.resolve({
        runtimeKind: 'rust',
        requester: {},
        fallbackSender: 'fallback',
      });

      expect(result.sender).toBe('fallback');
    });

    it('falls back to config.runtimeDevAgentId as last resort', async () => {
      service = new RuntimeCredentialResolverService(
        buildConfig({ runtimeDevAgentId: 'dev-agent-99' }) as AppConfigService,
      );

      const result = await service.resolve({
        runtimeKind: 'rust',
      });

      expect(result.sender).toBe('dev-agent-99');
    });

    it('uses config.runtimeDevAgentId when all optional fields are undefined', async () => {
      const result = await service.resolve({
        runtimeKind: 'rust',
        requester: undefined,
        participant: undefined,
        fallbackSender: undefined,
      });

      expect(result.sender).toBe('control-plane');
    });
  });

  // ===========================================================================
  // Metadata — bearer token
  // ===========================================================================
  describe('bearer token in metadata', () => {
    it('sets authorization header when runtimeBearerToken is configured', async () => {
      service = new RuntimeCredentialResolverService(
        buildConfig({ runtimeBearerToken: 'my-secret-token' }) as AppConfigService,
      );

      const result = await service.resolve({ runtimeKind: 'rust' });

      expect(result.metadata.authorization).toBe('Bearer my-secret-token');
    });

    it('does not set x-macp-agent-id when bearer token is present (even if useDevHeader is true)', async () => {
      service = new RuntimeCredentialResolverService(
        buildConfig({
          runtimeBearerToken: 'token',
          runtimeUseDevHeader: true,
        }) as AppConfigService,
      );

      const result = await service.resolve({ runtimeKind: 'rust' });

      expect(result.metadata.authorization).toBe('Bearer token');
      expect(result.metadata['x-macp-agent-id']).toBeUndefined();
    });
  });

  // ===========================================================================
  // Metadata — dev header
  // ===========================================================================
  describe('dev header in metadata', () => {
    it('sets x-macp-agent-id when useDevHeader is true and no bearer token', async () => {
      service = new RuntimeCredentialResolverService(
        buildConfig({
          runtimeBearerToken: '',
          runtimeUseDevHeader: true,
          runtimeDevAgentId: 'dev-agent',
        }) as AppConfigService,
      );

      const result = await service.resolve({ runtimeKind: 'rust' });

      expect(result.metadata['x-macp-agent-id']).toBe('dev-agent');
      expect(result.metadata.authorization).toBeUndefined();
    });

    it('uses the resolved sender for x-macp-agent-id (not the config value)', async () => {
      service = new RuntimeCredentialResolverService(
        buildConfig({
          runtimeBearerToken: '',
          runtimeUseDevHeader: true,
          runtimeDevAgentId: 'default-agent',
        }) as AppConfigService,
      );

      const result = await service.resolve({
        runtimeKind: 'rust',
        participant: { id: 'agent-42' },
      });

      expect(result.metadata['x-macp-agent-id']).toBe('agent-42');
    });
  });

  // ===========================================================================
  // No auth headers
  // ===========================================================================
  describe('no auth headers', () => {
    it('returns empty metadata when no bearer token and useDevHeader is false', async () => {
      service = new RuntimeCredentialResolverService(
        buildConfig({
          runtimeBearerToken: '',
          runtimeUseDevHeader: false,
        }) as AppConfigService,
      );

      const result = await service.resolve({ runtimeKind: 'rust' });

      expect(result.metadata).toEqual({});
    });
  });
});
