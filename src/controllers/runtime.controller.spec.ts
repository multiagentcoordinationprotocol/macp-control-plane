import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { PolicyRulesValidatorService } from '../policy/policy-rules-validator.service';
import { RuntimeController } from './runtime.controller';
import { AppConfigService } from '../config/app-config.service';
import { RuntimeProviderRegistry } from '../runtime/runtime-provider.registry';
import { RuntimeCapabilitiesService } from '../runtime/runtime-capabilities.service';

describe('RuntimeController', () => {
  let controller: RuntimeController;
  let mockConfig: Partial<AppConfigService>;
  let mockRuntimeRegistry: { get: jest.Mock };
  let mockCapabilities: { refresh: jest.Mock };
  let mockProvider: {
    getManifest: jest.Mock;
    listModes: jest.Mock;
    listRoots: jest.Mock;
    health: jest.Mock;
    registerPolicy: jest.Mock;
    unregisterPolicy: jest.Mock;
    capabilities?: unknown;
  };

  beforeEach(() => {
    mockProvider = {
      getManifest: jest.fn(),
      listModes: jest.fn(),
      listRoots: jest.fn(),
      health: jest.fn(),
      registerPolicy: jest.fn(),
      unregisterPolicy: jest.fn()
    };

    mockConfig = {
      runtimeKind: 'rust'
    };

    mockRuntimeRegistry = {
      get: jest.fn().mockReturnValue(mockProvider)
    };

    mockCapabilities = { refresh: jest.fn() };

    controller = new RuntimeController(
      mockConfig as AppConfigService,
      mockRuntimeRegistry as unknown as RuntimeProviderRegistry,
      new PolicyRulesValidatorService(),
      mockCapabilities as unknown as RuntimeCapabilitiesService
    );
  });

  // ===========================================================================
  // getCapabilities
  // ===========================================================================
  describe('getCapabilities', () => {
    it('returns a fresh Initialize of the configured runtime', async () => {
      mockCapabilities.refresh.mockResolvedValue({
        selectedProtocolVersion: '1.0',
        runtimeInfo: { name: 'macp-runtime', version: '0.10.0' },
        supportedModes: ['macp.mode.decision.v1'],
        capabilities: { policyRegistry: { whatIfReplay: true } },
        instructions: 'not echoed'
      });

      await expect(controller.getCapabilities()).resolves.toEqual({
        runtimeInfo: { name: 'macp-runtime', version: '0.10.0' },
        selectedProtocolVersion: '1.0',
        supportedModes: ['macp.mode.decision.v1'],
        capabilities: { policyRegistry: { whatIfReplay: true } }
      });
      expect(mockRuntimeRegistry.get).toHaveBeenCalledWith('rust');
      expect(mockCapabilities.refresh).toHaveBeenCalledWith(mockProvider);
    });

    it('answers {} when the runtime advertises no capabilities', async () => {
      mockCapabilities.refresh.mockResolvedValue({ selectedProtocolVersion: '1.0', runtimeInfo: {}, supportedModes: [] });
      expect((await controller.getCapabilities()).capabilities).toEqual({});
    });
  });

  // ===========================================================================
  // getManifest
  // ===========================================================================
  describe('getManifest', () => {
    it('delegates to provider.getManifest via registry', async () => {
      const manifest = {
        agentId: 'rust-runtime',
        title: 'Rust Runtime',
        supportedModes: ['macp.mode.decision.v1']
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
        { mode: 'macp.mode.decision.v1', modeVersion: '1.0.0', messageTypes: [], terminalMessageTypes: [] }
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

    it('defaults an omitted schemaVersion to 3', async () => {
      mockProvider.registerPolicy.mockResolvedValue({ ok: true });

      await controller.registerPolicy({
        policyId: 'policy.test',
        mode: 'macp.mode.decision.v1',
        description: 'Test policy',
        rules: { voting: { algorithm: 'majority' } }
      });

      expect(mockProvider.registerPolicy).toHaveBeenCalledWith({
        descriptor: expect.objectContaining({ schemaVersion: 3 })
      });
    });

    it('honours an explicit schemaVersion of 1', async () => {
      mockProvider.registerPolicy.mockResolvedValue({ ok: true });

      await controller.registerPolicy({
        policyId: 'policy.test',
        mode: 'macp.mode.decision.v1',
        description: 'Test policy',
        rules: { voting: { algorithm: 'majority' } },
        schemaVersion: 1
      });

      expect(mockProvider.registerPolicy).toHaveBeenCalledWith({
        descriptor: expect.objectContaining({ schemaVersion: 1 })
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
          rules: { voting: { algorithm: 'majority' } },
          schemaVersion: 1
        })
      ).rejects.toThrow('INVALID_POLICY_DEFINITION');
    });

    it.each([
      ['an unknown top-level key', 'macp.mode.decision.v1', { invalid: true }, 'unrecognized key "invalid"'],
      [
        'a misspelled nested key (veto_threshhold)',
        'macp.mode.decision.v1',
        { objection_handling: { veto_threshhold: 1 } },
        'veto_threshhold'
      ],
      [
        'an unknown key under the wildcard mode',
        '*',
        { not_a_rule_key: 1 },
        'rules.not_a_rule_key is not a defined key'
      ]
    ])('rejects %s without calling the runtime', async (_label, mode, rules, expected) => {
      await expect(
        controller.registerPolicy({ policyId: 'policy.typo', mode, description: 'typo', rules, schemaVersion: 3 })
      ).rejects.toThrow(expected);
      expect(mockProvider.registerPolicy).not.toHaveBeenCalled();
    });

    it('accepts valid rules for a wildcard-mode policy and for an extension mode with no vendored schema', async () => {
      mockProvider.registerPolicy.mockResolvedValue({ ok: true });

      await controller.registerPolicy({
        policyId: 'policy.wild',
        mode: '*',
        description: 'wildcard',
        rules: { voting: { algorithm: 'majority' }, commitment: { authority: 'any_participant' } },
        schemaVersion: 3
      });
      await controller.registerPolicy({
        policyId: 'policy.ext',
        mode: 'ext.custom.v1',
        description: 'extension mode',
        rules: { anything: { goes: true } },
        schemaVersion: 3
      });

      expect(mockProvider.registerPolicy).toHaveBeenCalledTimes(2);
    });

    describe('annotation and vendor-extension keys (runtime v0.9.0 admission parity)', () => {
      const register = (rules: Record<string, unknown>, mode = 'macp.mode.decision.v1') =>
        controller.registerPolicy({ policyId: 'policy.s1', mode, description: 's1', rules, schemaVersion: 3 });

      it('forwards a wildcard policy carrying annotation keys', async () => {
        mockProvider.registerPolicy.mockResolvedValue({ ok: true });
        await register({ _note: 'why', voting: { $comment: 'x', algorithm: 'majority' } }, '*');
        expect(mockProvider.registerPolicy).toHaveBeenCalledTimes(1);
      });

      it('refuses an x- key the runtime did not advertise, naming it, without calling the runtime', async () => {
        mockProvider.capabilities = { policyRegistry: { registerPolicy: true, ruleExtensions: [] } };
        await expect(register({ 'x-com.example': {} })).rejects.toThrow(
          /^INVALID_POLICY_DEFINITION: invalid policy rules for mode "macp\.mode\.decision\.v1": rules\.x-com\.example is not a defined key/
        );
        mockProvider.capabilities = { policyRegistry: { registerPolicy: true, ruleExtensions: ['x-org.other'] } };
        await expect(register({ 'x-com.example': {} })).rejects.toThrow(
          `this runtime implements no vendor extension 'x-com.example' (implemented: ["x-org.other"])`
        );
        expect(mockProvider.registerPolicy).not.toHaveBeenCalled();
      });

      it('forwards an advertised x- key', async () => {
        mockProvider.capabilities = { policyRegistry: { registerPolicy: true, ruleExtensions: ['x-com.example'] } };
        mockProvider.registerPolicy.mockResolvedValue({ ok: true });
        await register({ 'x-com.example': { require_reason: true } });
        expect(mockProvider.registerPolicy).toHaveBeenCalledTimes(1);
      });

      it.each([
        ['no capabilities cached', undefined],
        ['a malformed ruleExtensions value', { policyRegistry: { ruleExtensions: 'x-com.example' } }]
      ])('leaves the extension name to the runtime with %s', async (_label, capabilities) => {
        mockProvider.capabilities = capabilities;
        mockProvider.registerPolicy.mockResolvedValue({ ok: true });
        await register({ 'x-com.example': {} });
        expect(mockProvider.registerPolicy).toHaveBeenCalledTimes(1);
      });

      it.each([
        ['a non-object x- value', { 'x-com.example': 1 }, 'a vendor-extension value must be a JSON object'],
        [
          'a nested x- key',
          { voting: { algorithm: 'majority', 'x-com.example': {} } },
          'vendor-extension keys are legal only at the top level of rules'
        ]
      ])('refuses %s even when the runtime advertises the key', async (_label, rules, expected) => {
        mockProvider.capabilities = { policyRegistry: { registerPolicy: true, ruleExtensions: ['x-com.example'] } };
        await expect(register(rules)).rejects.toThrow(expected);
        expect(mockProvider.registerPolicy).not.toHaveBeenCalled();
      });
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

    it('returns REGISTRY_READ_ONLY 405 when capabilities advertise a read-only registry (T9)', async () => {
      mockProvider.capabilities = { policyRegistry: { registerPolicy: false } };

      const err = await controller
        .registerPolicy({
          policyId: 'policy.ro',
          mode: 'macp.mode.decision.v1',
          description: 'read-only',
          rules: { voting: { algorithm: 'majority' } },
          schemaVersion: 1
        })
        .catch((e) => e);

      expect(err.errorCode).toBe('REGISTRY_READ_ONLY');
      expect(err.getStatus()).toBe(405);
      expect(mockProvider.registerPolicy).not.toHaveBeenCalled();
    });

    const registerRo = (policyId: string) =>
      controller
        .registerPolicy({
          policyId,
          mode: 'macp.mode.decision.v1',
          description: 'read-only',
          rules: { voting: { algorithm: 'majority' } },
          schemaVersion: 1
        })
        .catch((e) => e);

    // `provider.unary()` rethrows `mapGrpcError(...)`, so a 0.8.x read-only
    // FAILED_PRECONDITION arrives as AppException(CONFLICT, …, {grpcCode: 9}).
    it('returns REGISTRY_READ_ONLY 405 when a 0.8.x runtime rejects with a read-only FAILED_PRECONDITION (T9)', async () => {
      mockProvider.registerPolicy.mockRejectedValue(
        new AppException(ErrorCode.CONFLICT, 'policy registry is read-only (MACP_POLICIES_DIR)', 409, { grpcCode: 9 })
      );

      const err = await registerRo('policy.ro2');

      expect(err.errorCode).toBe('REGISTRY_READ_ONLY');
      expect(err.getStatus()).toBe(405);
    });

    it('returns REGISTRY_READ_ONLY 405 for a raw read-only FAILED_PRECONDITION ServiceError (T9)', async () => {
      mockProvider.registerPolicy.mockRejectedValue(
        Object.assign(new Error('9 FAILED_PRECONDITION: policy registry is read-only'), {
          code: 9,
          details: 'policy registry is read-only'
        })
      );

      const err = await registerRo('policy.ro3');

      expect(err.errorCode).toBe('REGISTRY_READ_ONLY');
      expect(err.getStatus()).toBe(405);
    });

    it('keys on a coded REGISTRY_READ_ONLY even when the message never says "read-only" (runtime v0.9.0)', async () => {
      mockProvider.registerPolicy.mockRejectedValue(
        new AppException(ErrorCode.REGISTRY_READ_ONLY, 'registry writes disabled', 405, {
          grpcCode: 9,
          macpErrorCode: 'REGISTRY_READ_ONLY'
        })
      );

      const err = await registerRo('policy.ro4');

      expect(err.errorCode).toBe('REGISTRY_READ_ONLY');
      expect(err.getStatus()).toBe(405);
      expect(err.metadata).toMatchObject({ macpErrorCode: 'REGISTRY_READ_ONLY' });
    });

    it('does not reclassify a differently-coded FAILED_PRECONDITION whose text mentions read-only (runtime v0.9.0)', async () => {
      const coded = new AppException(ErrorCode.SESSION_NOT_OPEN, 'session is read-only now', 409, {
        grpcCode: 9,
        macpErrorCode: 'SESSION_NOT_OPEN'
      });
      mockProvider.registerPolicy.mockRejectedValue(coded);

      const err = await registerRo('policy.ro5');

      expect(err).toBe(coded);
    });

    it('rethrows an unrelated uncoded FAILED_PRECONDITION unchanged', async () => {
      const conflict = new AppException(ErrorCode.CONFLICT, 'policy busy', 409, { grpcCode: 9 });
      mockProvider.registerPolicy.mockRejectedValue(conflict);

      expect(await registerRo('policy.ro6')).toBe(conflict);
    });

    it('unregisterPolicy surfaces REGISTRY_READ_ONLY on a read-only registry (T9)', async () => {
      mockProvider.capabilities = { policyRegistry: { registerPolicy: false } };

      const err = await controller.unregisterPolicy('policy.ro').catch((e) => e);

      expect(err.errorCode).toBe('REGISTRY_READ_ONLY');
      expect(err.getStatus()).toBe(405);
      expect(mockProvider.unregisterPolicy).not.toHaveBeenCalled();
    });

    it('rejects reserved policy.default policyId', async () => {
      await expect(
        controller.registerPolicy({
          policyId: 'policy.default',
          mode: '*',
          description: 'Reserved',
          rules: {},
          schemaVersion: 1
        })
      ).rejects.toThrow('policy.default is reserved');
    });

    it('rejects empty policyId', async () => {
      await expect(
        controller.registerPolicy({
          policyId: '',
          mode: '*',
          description: 'Empty',
          rules: {},
          schemaVersion: 1
        })
      ).rejects.toThrow('policyId is required');
    });

    it('rejects schemaVersion < 1', async () => {
      await expect(
        controller.registerPolicy({
          policyId: 'policy.test',
          mode: '*',
          description: 'Bad version',
          rules: {},
          schemaVersion: 0
        })
      ).rejects.toThrow('schemaVersion must be one of 1, 2, 3');
    });

    it('rejects an out-of-range schemaVersion (the runtime accepts this at registration today and only fails later, silently, at evaluation)', async () => {
      await expect(
        controller.registerPolicy({
          policyId: 'policy.test',
          mode: '*',
          description: 'Out of range version',
          rules: {},
          schemaVersion: 99
        })
      ).rejects.toThrow('schemaVersion must be one of 1, 2, 3');
      expect(mockProvider.registerPolicy).not.toHaveBeenCalled();
    });

    it('rejects a non-integer schemaVersion', async () => {
      await expect(
        controller.registerPolicy({
          policyId: 'policy.test',
          mode: '*',
          description: 'Fractional version',
          rules: {},
          schemaVersion: 1.5
        })
      ).rejects.toThrow('schemaVersion must be one of 1, 2, 3');
      expect(mockProvider.registerPolicy).not.toHaveBeenCalled();
    });

    it('accepts schemaVersion 2', async () => {
      mockProvider.registerPolicy.mockResolvedValue({ ok: true });

      const result = await controller.registerPolicy({
        policyId: 'policy.test',
        mode: 'macp.mode.decision.v1',
        description: 'Version 2',
        rules: { voting: { algorithm: 'majority' } },
        schemaVersion: 2
      });

      expect(result).toEqual({ ok: true });
      expect(mockProvider.registerPolicy).toHaveBeenCalled();
    });

    it('accepts schemaVersion 3', async () => {
      mockProvider.registerPolicy.mockResolvedValue({ ok: true });

      const result = await controller.registerPolicy({
        policyId: 'policy.test',
        mode: 'macp.mode.decision.v1',
        description: 'Version 3',
        rules: { voting: { algorithm: 'majority' } },
        schemaVersion: 3
      });

      expect(result).toEqual({ ok: true });
      expect(mockProvider.registerPolicy).toHaveBeenCalled();
    });

    it('rejects weighted algorithm without weights', async () => {
      await expect(
        controller.registerPolicy({
          policyId: 'policy.test',
          mode: 'macp.mode.decision.v1',
          description: 'Missing weights',
          rules: { voting: { algorithm: 'weighted' } },
          schemaVersion: 1
        })
      ).rejects.toThrow('weighted voting algorithm requires a weights map');
    });

    it('rejects supermajority with threshold <= 0.5', async () => {
      await expect(
        controller.registerPolicy({
          policyId: 'policy.test',
          mode: 'macp.mode.decision.v1',
          description: 'Bad threshold',
          rules: { voting: { algorithm: 'supermajority', threshold: 0.5 } },
          schemaVersion: 1
        })
      ).rejects.toThrow('supermajority voting requires threshold > 0.5');
    });

    it('rejects designated_role without designated_roles', async () => {
      await expect(
        controller.registerPolicy({
          policyId: 'policy.test',
          mode: 'macp.mode.decision.v1',
          description: 'Missing roles',
          rules: { commitment: { authority: 'designated_role' } },
          schemaVersion: 1
        })
      ).rejects.toThrow('designated_role authority requires non-empty designated_roles list');
    });

    it('accepts valid policy with weighted algorithm and weights', async () => {
      mockProvider.registerPolicy.mockResolvedValue({ ok: true });

      const result = await controller.registerPolicy({
        policyId: 'policy.weighted',
        mode: 'macp.mode.decision.v1',
        description: 'Weighted voting',
        rules: { voting: { algorithm: 'weighted', weights: { alice: 2, bob: 1 } } },
        schemaVersion: 1
      });

      expect(result).toEqual({ ok: true });
    });
  });
});
