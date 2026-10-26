import { HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  DEFAULT_POLICY_SCHEMA_VERSION,
  RuntimeCapabilities,
  RuntimeWhatIfEntryOutcome,
  RuntimeWhatIfOutcome
} from '../contracts/runtime';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { PolicyRulesValidatorService } from '../policy/policy-rules-validator.service';
import { RunManagerService } from '../runs/run-manager.service';
import { parsePolicyDenyDetails, PolicyDenyDetails } from '../runtime/grpc-helpers';
import { ProtoRegistryService } from '../runtime/proto-registry.service';
import { RuntimeCapabilitiesService } from '../runtime/runtime-capabilities.service';
import { RuntimeProviderRegistry } from '../runtime/runtime-provider.registry';

const WILDCARD_MODE = '*';

export type WhatIfState = 'OPEN' | 'RESOLVED' | 'EXPIRED' | 'CANCELLED' | 'SUSPENDED';
export type WhatIfEntryKind = 'APPLIED' | 'NOT_OPEN' | 'REFUSED' | 'NO_SESSION';

export interface WhatIfCandidateInput {
  mode?: string;
  rules: Record<string, unknown>;
  schemaVersion?: number;
  policyId?: string;
  description?: string;
}

export interface WhatIfOutcomeView {
  state: WhatIfState | null;
  resolution: Record<string, unknown> | null;
  resolvedBy: { historyIndex: number; messageId: string; messageType: string } | null;
}

export interface WhatIfEntryOutcomeView {
  kind: WhatIfEntryKind | null;
  state: WhatIfState | null;
  errorCode: string | null;
  details: PolicyDenyDetails | null;
}

export interface WhatIfReplayView {
  runId: string;
  sessionId: string;
  recordedPolicyId: string;
  candidatePolicyId: string;
  recorded: WhatIfOutcomeView;
  candidate: WhatIfOutcomeView;
  firstDivergence: number | null;
  denials: Array<{ historyIndex: number; messageId: string; details: PolicyDenyDetails | null }>;
  entries: Array<{
    historyIndex: number;
    messageId: string;
    messageType: string;
    recorded: WhatIfEntryOutcomeView;
    candidate: WhatIfEntryOutcomeView;
  }>;
}

/**
 * Proxies the runtime's read-only `WhatIfReplay` RPC (RFC-MACP-0012 §8.1, adoption roadmap W4.1):
 * replays a run's session under a candidate policy and returns both outcomes and where they diverge.
 *
 * Nothing is persisted and no envelope is emitted, so no run, event or projection changes. The
 * candidate gets the same pre-checks as `POST /runtime/policies`; the runtime's admission is
 * authoritative either way.
 */
@Injectable()
export class WhatIfReplayService {
  private readonly logger = new Logger(WhatIfReplayService.name);

  constructor(
    private readonly runManager: RunManagerService,
    private readonly runtimeRegistry: RuntimeProviderRegistry,
    private readonly capabilities: RuntimeCapabilitiesService,
    private readonly policyRulesValidator: PolicyRulesValidatorService,
    private readonly protoRegistry: ProtoRegistryService
  ) {}

  async replay(runId: string, input: WhatIfCandidateInput): Promise<WhatIfReplayView> {
    const run = await this.findRun(runId);
    const sessionId = run.runtimeSessionId;
    if (!sessionId) {
      throw new AppException(ErrorCode.NOT_FOUND, `run ${runId} has no runtime session yet`, HttpStatus.NOT_FOUND);
    }
    const provider = this.runtimeRegistry.get(run.runtimeKind);
    const capabilities = await this.capabilities.forWhatIfReplay(provider);
    if (capabilities?.policyRegistry?.whatIfReplay !== true) {
      throw new AppException(
        ErrorCode.WHAT_IF_REPLAY_UNSUPPORTED,
        'runtime does not advertise policyRegistry.whatIfReplay (requires macp-runtime >= 0.10)',
        HttpStatus.NOT_IMPLEMENTED
      );
    }

    const mode = input.mode ?? (await provider.getSession({ runId, runtimeSessionId: sessionId })).mode;
    const schemaVersion = input.schemaVersion ?? DEFAULT_POLICY_SCHEMA_VERSION;
    this.assertCandidateRules(mode, input.rules, capabilities);

    const result = await provider.whatIfReplay({
      runtimeSessionId: sessionId,
      candidate: {
        policyId: input.policyId ?? '',
        mode,
        description: input.description ?? '',
        rules: Buffer.from(JSON.stringify(input.rules)),
        schemaVersion
      }
    });

    return {
      runId,
      sessionId,
      recordedPolicyId: result.recordedPolicyId,
      candidatePolicyId: result.candidatePolicyId,
      recorded: this.outcome(result.recorded, mode),
      candidate: this.outcome(result.candidate, mode),
      firstDivergence: result.firstDivergence ?? null,
      denials: result.denials.map((d) => ({
        historyIndex: d.historyIndex,
        messageId: d.messageId,
        details: parsePolicyDenyDetails(d.details) ?? null
      })),
      entries: result.entries.map((e) => ({
        historyIndex: e.historyIndex,
        messageId: e.messageId,
        messageType: e.messageType,
        recorded: entryOutcome(e.recorded),
        candidate: entryOutcome(e.candidate)
      }))
    };
  }

  /** Coded (`RUN_NOT_FOUND`) so every what-if error a client branches on carries an `errorCode`. */
  private async findRun(runId: string) {
    try {
      return await this.runManager.getRun(runId);
    } catch (err) {
      if (err instanceof NotFoundException) {
        throw new AppException(ErrorCode.RUN_NOT_FOUND, `run ${runId} not found`, HttpStatus.NOT_FOUND);
      }
      throw err;
    }
  }

  private assertCandidateRules(mode: string, rules: Record<string, unknown>, capabilities: RuntimeCapabilities) {
    const targeted = this.policyRulesValidator.targetedRuleError(rules);
    const errors = targeted
      ? [targeted]
      : this.policyRulesValidator.validateRules(mode, rules, {
          ruleExtensions: capabilities.policyRegistry?.ruleExtensions
        });
    if (errors.length > 0) {
      throw new AppException(
        ErrorCode.INVALID_POLICY_DEFINITION,
        `INVALID_POLICY_DEFINITION: invalid policy rules for mode "${mode}": ${errors.join('; ')}`,
        HttpStatus.BAD_REQUEST
      );
    }
  }

  private outcome(o: RuntimeWhatIfOutcome, mode: string): WhatIfOutcomeView {
    return {
      state: stateOf(o.state),
      resolution: o.resolution.length > 0 ? this.decodeCommitment(o.resolution, mode) : null,
      resolvedBy: o.resolvedByMessageId
        ? {
            historyIndex: o.resolvedByHistoryIndex,
            messageId: o.resolvedByMessageId,
            messageType: o.resolvedByMessageType
          }
        : null
    };
  }

  private decodeCommitment(bytes: Buffer, mode: string): Record<string, unknown> {
    const typeName = this.protoRegistry.getKnownTypeName(mode === WILDCARD_MODE ? '' : mode, 'Commitment');
    try {
      return this.protoRegistry.decodeMessage(typeName ?? 'macp.v1.CommitmentPayload', bytes);
    } catch (err) {
      this.logger.warn(`what-if resolution did not decode as a Commitment: ${(err as Error).message}`);
      return { payloadBase64: bytes.toString('base64') };
    }
  }
}

const STATE_PREFIX = 'SESSION_STATE_';
const KIND_PREFIX = 'KIND_';

function stateOf(raw: string): WhatIfState | null {
  if (!raw.startsWith(STATE_PREFIX) || raw === 'SESSION_STATE_UNSPECIFIED') return null;
  return raw.slice(STATE_PREFIX.length) as WhatIfState;
}

function entryOutcome(o: RuntimeWhatIfEntryOutcome): WhatIfEntryOutcomeView {
  return {
    kind:
      o.kind.startsWith(KIND_PREFIX) && o.kind !== 'KIND_UNSPECIFIED'
        ? (o.kind.slice(KIND_PREFIX.length) as WhatIfEntryKind)
        : null,
    state: stateOf(o.state),
    errorCode: o.errorCode || null,
    details: parsePolicyDenyDetails(o.details) ?? null
  };
}
