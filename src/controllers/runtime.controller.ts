import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AppConfigService } from '../config/app-config.service';
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
  async registerPolicy(@Body() body: {
    policyId: string;
    mode: string;
    description: string;
    rules: Record<string, unknown>;
    schemaVersion?: number;
  }) {
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
    const result = await provider.registerPolicy({
      descriptor: {
        policyId: body.policyId,
        mode: body.mode,
        description: body.description,
        rules: Buffer.from(JSON.stringify(body.rules)),
        schemaVersion
      }
    });
    if (!result.ok && result.error?.includes('INVALID_POLICY_DEFINITION')) {
      throw new BadRequestException(result.error);
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
      rules: typeof policy.rules === 'string' ? JSON.parse(policy.rules) : JSON.parse(Buffer.from(policy.rules).toString())
    };
  }

  @Delete('policies/:policyId')
  @ApiOperation({ summary: 'Unregister a governance policy.' })
  @ApiParam({ name: 'policyId', description: 'Policy identifier' })
  @ApiOkResponse({ type: RuntimeUnregisterPolicyResultDto })
  async unregisterPolicy(@Param('policyId') policyId: string) {
    const provider = this.runtimeRegistry.get(this.config.runtimeKind);
    return provider.unregisterPolicy({ policyId });
  }
}
