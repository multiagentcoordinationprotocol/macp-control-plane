import { BadRequestException, Body, Controller, Delete, Get, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AppConfigService } from '../config/app-config.service';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { RuntimeHealthResponseDto } from '../dto/run-responses.dto';
import {
  RuntimeManifestResultDto,
  RuntimeModeDescriptorDto,
  RuntimeRootDescriptorDto,
  RuntimePolicyDescriptorDto,
  RuntimeRegisterPolicyResultDto,
  RuntimeUnregisterPolicyResultDto
} from '../dto/runtime-responses.dto';
import { RuntimeProviderRegistry } from '../runtime/runtime-provider.registry';

@ApiTags('runtime')
@Controller('runtime')
export class RuntimeController {
  constructor(
    private readonly config: AppConfigService,
    private readonly runtimeRegistry: RuntimeProviderRegistry
  ) {}

  @Get('manifest')
  @ApiOperation({ summary: 'Fetch runtime manifest from the configured runtime provider.' })
  @ApiOkResponse({ type: RuntimeManifestResultDto })
  async getManifest() {
    return this.runtimeRegistry.get(this.config.runtimeKind).getManifest();
  }

  @Get('modes')
  @ApiOperation({ summary: 'List runtime-advertised modes.' })
  @ApiOkResponse({ type: [RuntimeModeDescriptorDto] })
  async listModes() {
    return this.runtimeRegistry.get(this.config.runtimeKind).listModes();
  }

  @Get('roots')
  @ApiOperation({ summary: 'List runtime-advertised roots.' })
  @ApiOkResponse({ type: [RuntimeRootDescriptorDto] })
  async listRoots() {
    return this.runtimeRegistry.get(this.config.runtimeKind).listRoots();
  }

  @Get('health')
  @ApiOkResponse({ type: RuntimeHealthResponseDto })
  @ApiOperation({ summary: 'Check runtime reachability and manifest availability.' })
  async health() {
    return this.runtimeRegistry.get(this.config.runtimeKind).health();
  }

  // ── Governance policy lifecycle (RFC-MACP-0012) ──────────────────

  @Post('policies')
  @ApiOperation({ summary: 'Register a governance policy with the runtime.' })
  @ApiBody({ description: 'Policy descriptor with rules' })
  @ApiOkResponse({ type: RuntimeRegisterPolicyResultDto })
  async registerPolicy(
    @Body()
    body: {
      policyId: string;
      mode: string;
      description: string;
      rules: Record<string, unknown>;
      schemaVersion?: number;
    }
  ) {
    // Pre-validate before forwarding to runtime
    if (!body.policyId || body.policyId.trim().length === 0) {
      throw new BadRequestException('policyId is required');
    }
    if (body.policyId === 'policy.default') {
      throw new BadRequestException('policy.default is reserved and cannot be registered');
    }
    const schemaVersion = body.schemaVersion ?? 1;
    if (schemaVersion < 1) {
      throw new BadRequestException('schemaVersion must be > 0');
    }
    if (!body.rules || typeof body.rules !== 'object' || Array.isArray(body.rules)) {
      throw new BadRequestException('rules must be a JSON object');
    }

    // Mode-specific conditional validations
    const rules = body.rules as Record<string, unknown>;
    const voting = rules.voting as Record<string, unknown> | undefined;
    if (voting?.algorithm === 'weighted' && (!voting.weights || typeof voting.weights !== 'object')) {
      throw new BadRequestException('weighted voting algorithm requires a weights map');
    }
    if (voting?.algorithm === 'supermajority' && (typeof voting.threshold !== 'number' || voting.threshold <= 0.5)) {
      throw new BadRequestException('supermajority voting requires threshold > 0.5');
    }
    const commitment = rules.commitment as Record<string, unknown> | undefined;
    if (commitment?.authority === 'designated_role') {
      const roles = commitment.designated_roles ?? commitment.designatedRoles;
      if (!Array.isArray(roles) || roles.length === 0) {
        throw new BadRequestException('designated_role authority requires non-empty designated_roles list');
      }
    }

    const provider = this.runtimeRegistry.get(this.config.runtimeKind);
    // Short-circuit when the runtime advertised a read-only policy registry
    // (MACP_POLICIES_DIR) via its Initialize capabilities — clearer than letting
    // the write fail with a generic 409.
    this.assertRegistryWritable(provider);
    let result: Awaited<ReturnType<typeof provider.registerPolicy>>;
    try {
      result = await provider.registerPolicy({
        descriptor: {
          policyId: body.policyId,
          mode: body.mode,
          description: body.description,
          rules: Buffer.from(JSON.stringify(body.rules)),
          schemaVersion
        }
      });
    } catch (err) {
      throw this.translateRegistryError(err);
    }
    if (!result.ok && result.error?.includes('INVALID_POLICY_DEFINITION')) {
      throw new BadRequestException(result.error);
    }
    if (!result.ok && this.isReadOnlyMessage(result.error)) {
      throw this.readOnlyException(result.error);
    }
    return result;
  }

  @Get('policies')
  @ApiOperation({ summary: 'List registered governance policies.' })
  @ApiQuery({ name: 'mode', required: false, description: 'Filter by target mode' })
  @ApiOkResponse({ type: [RuntimePolicyDescriptorDto] })
  async listPolicies(@Query('mode') mode?: string) {
    const provider = this.runtimeRegistry.get(this.config.runtimeKind);
    const policies = await provider.listPolicies({ mode });
    return policies.map((p) => ({
      ...p,
      rules: typeof p.rules === 'string' ? JSON.parse(p.rules) : JSON.parse(Buffer.from(p.rules).toString())
    }));
  }

  @Get('policies/:policyId')
  @ApiOperation({ summary: 'Get a governance policy by ID.' })
  @ApiParam({ name: 'policyId', description: 'Policy identifier' })
  @ApiOkResponse({ type: RuntimePolicyDescriptorDto })
  async getPolicy(@Param('policyId') policyId: string) {
    const provider = this.runtimeRegistry.get(this.config.runtimeKind);
    const policy = await provider.getPolicy({ policyId });
    return {
      ...policy,
      rules:
        typeof policy.rules === 'string' ? JSON.parse(policy.rules) : JSON.parse(Buffer.from(policy.rules).toString())
    };
  }

  @Delete('policies/:policyId')
  @ApiOperation({ summary: 'Unregister a governance policy.' })
  @ApiParam({ name: 'policyId', description: 'Policy identifier' })
  @ApiOkResponse({ type: RuntimeUnregisterPolicyResultDto })
  async unregisterPolicy(@Param('policyId') policyId: string) {
    const provider = this.runtimeRegistry.get(this.config.runtimeKind);
    this.assertRegistryWritable(provider);
    let result: Awaited<ReturnType<typeof provider.unregisterPolicy>>;
    try {
      result = await provider.unregisterPolicy({ policyId });
    } catch (err) {
      throw this.translateRegistryError(err);
    }
    if (!result.ok && this.isReadOnlyMessage(result.error)) {
      throw this.readOnlyException(result.error);
    }
    return result;
  }

  /**
   * Reject registry writes up-front when the runtime's Initialize response
   * advertised `policyRegistry.registerPolicy === false` (a read-only registry
   * backed by `MACP_POLICIES_DIR`, runtime v0.5.0). Only trips when the provider
   * exposes cached capabilities; otherwise the error path below still catches
   * the runtime's FAILED_PRECONDITION rejection.
   */
  private assertRegistryWritable(provider: ReturnType<RuntimeProviderRegistry['get']>): void {
    const capabilities = (provider as { capabilities?: { policyRegistry?: { registerPolicy?: boolean } } })
      .capabilities;
    if (capabilities?.policyRegistry && capabilities.policyRegistry.registerPolicy === false) {
      throw this.readOnlyException('runtime policy registry is read-only (MACP_POLICIES_DIR)');
    }
  }

  /**
   * Translate a thrown runtime error into a read-only 405 when it is the
   * runtime's FAILED_PRECONDITION rejection for a read-only registry; otherwise
   * rethrow unchanged so the global filter maps it as before.
   */
  private translateRegistryError(err: unknown): unknown {
    const grpcCode = (err as { details?: { grpcCode?: number } })?.details?.grpcCode;
    const message = err instanceof Error ? err.message : String(err);
    // grpc FAILED_PRECONDITION === 9.
    if ((grpcCode === 9 || err instanceof AppException) && this.isReadOnlyMessage(message)) {
      return this.readOnlyException(message);
    }
    return err;
  }

  private isReadOnlyMessage(message?: string): boolean {
    if (!message) return false;
    const m = message.toLowerCase();
    return m.includes('read-only') || m.includes('read only') || m.includes('macp_policies_dir') || m.includes('immutable');
  }

  private readOnlyException(message?: string): AppException {
    return new AppException(
      ErrorCode.REGISTRY_READ_ONLY,
      message && this.isReadOnlyMessage(message)
        ? message
        : 'runtime policy registry is read-only and cannot be modified',
      HttpStatus.METHOD_NOT_ALLOWED
    );
  }
}
