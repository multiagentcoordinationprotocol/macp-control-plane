import { RuntimeController } from './runtime.controller';
import { AppConfigService } from '../config/app-config.service';
import { RuntimeProviderRegistry } from '../runtime/runtime-provider.registry';

describe('RuntimeController', () => {
  let controller: RuntimeController;
  let mockConfig: Partial<AppConfigService>;
  let mockRuntimeRegistry: { get: jest.Mock };
  let mockProvider: {
    getManifest: jest.Mock;
    listModes: jest.Mock;
    listRoots: jest.Mock;
    health: jest.Mock;
    registerPolicy: jest.Mock;
  };

  beforeEach(() => {
    mockProvider = {
      getManifest: jest.fn(),
      listModes: jest.fn(),
      listRoots: jest.fn(),
      health: jest.fn(),
      registerPolicy: jest.fn(),
    };

    mockConfig = {
      runtimeKind: 'rust',
    };

    mockRuntimeRegistry = {
      get: jest.fn().mockReturnValue(mockProvider),
    };

    controller = new RuntimeController(
      mockConfig as AppConfigService,
      mockRuntimeRegistry as unknown as RuntimeProviderRegistry,
    );
  });

  // ===========================================================================
  // getManifest
  // ===========================================================================
  describe('getManifest', () => {
    it('delegates to provider.getManifest via registry', async () => {
      const manifest = {
        agentId: 'rust-runtime',
        title: 'Rust Runtime',
        supportedModes: ['macp.mode.decision.v1'],
      };
      mockProvider.getManifest.mockResolvedValue(manifest);

      const result = await controller.getManifest();

      expect(mockRuntimeRegistry.get).toHaveBeenCalledWith('rust');
      expect(mockProvider.getManifest).toHaveBeenCalled();
      expect(result).toEqual(manifest);
    });
  });

  // ===========================================================================
  // listModes
  // ===========================================================================
  describe('listModes', () => {
    it('delegates to provider.listModes via registry', async () => {
      const modes = [
        { mode: 'macp.mode.decision.v1', modeVersion: '1.0.0', messageTypes: [], terminalMessageTypes: [] },
      ];
      mockProvider.listModes.mockResolvedValue(modes);

      const result = await controller.listModes();

      expect(mockRuntimeRegistry.get).toHaveBeenCalledWith('rust');
      expect(mockProvider.listModes).toHaveBeenCalled();
      expect(result).toEqual(modes);
    });
  });

  // ===========================================================================
  // listRoots
  // ===========================================================================
  describe('listRoots', () => {
    it('delegates to provider.listRoots via registry', async () => {
      const roots = [{ uri: 'file:///workspace', name: 'workspace' }];
      mockProvider.listRoots.mockResolvedValue(roots);

      const result = await controller.listRoots();

      expect(mockRuntimeRegistry.get).toHaveBeenCalledWith('rust');
      expect(mockProvider.listRoots).toHaveBeenCalled();
      expect(result).toEqual(roots);
    });
  });

  // ===========================================================================
  // health
  // ===========================================================================
  describe('health', () => {
    it('delegates to provider.health via registry', async () => {
      const healthResult = { ok: true, runtimeKind: 'rust' };
      mockProvider.health.mockResolvedValue(healthResult);

      const result = await controller.health();

      expect(mockRuntimeRegistry.get).toHaveBeenCalledWith('rust');
      expect(mockProvider.health).toHaveBeenCalled();
      expect(result).toEqual(healthResult);
    });

    it('returns unhealthy result when provider reports unhealthy', async () => {
      const healthResult = { ok: false, runtimeKind: 'rust', detail: 'connection refused' };
      mockProvider.health.mockResolvedValue(healthResult);

      const result = await controller.health();

      expect(result).toEqual(healthResult);
      expect(result.ok).toBe(false);
    });
  });

  // ===========================================================================
  // registerPolicy
  // ===========================================================================
  describe('registerPolicy', () => {
    it('returns ok result on successful registration', async () => {
      mockProvider.registerPolicy.mockResolvedValue({ ok: true });

      const result = await controller.registerPolicy({
        policyId: 'policy.test',
        mode: 'macp.mode.decision.v1',
        description: 'Test policy',
        rules: { voting: { algorithm: 'majority' } },
        schemaVersion: 1
      });

      expect(result).toEqual({ ok: true });
      expect(mockProvider.registerPolicy).toHaveBeenCalledWith({
        descriptor: expect.objectContaining({
          policyId: 'policy.test',
          mode: 'macp.mode.decision.v1'
        })
      });
    });

    it('throws BadRequestException on INVALID_POLICY_DEFINITION', async () => {
      mockProvider.registerPolicy.mockResolvedValue({
        ok: false,
        error: 'INVALID_POLICY_DEFINITION: rules do not match decision mode schema'
      });

      await expect(
        controller.registerPolicy({
          policyId: 'policy.bad',
          mode: 'macp.mode.decision.v1',
          description: 'Bad policy',
          rules: { invalid: true },
          schemaVersion: 1
        })
      ).rejects.toThrow('INVALID_POLICY_DEFINITION');
    });

    it('returns error result for non-validation errors', async () => {
      mockProvider.registerPolicy.mockResolvedValue({
        ok: false,
        error: 'policy policy.dup already registered'
      });

      const result = await controller.registerPolicy({
        policyId: 'policy.dup',
        mode: '*',
        description: 'Duplicate',
        rules: {},
        schemaVersion: 1
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain('already registered');
    });
  });
});
