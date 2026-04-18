import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as path from 'node:path';
import * as protobuf from 'protobufjs';

const MESSAGE_TYPE_MAP: Record<string, Record<string, string>> = {
  __core__: {
    SessionStart: 'macp.v1.SessionStartPayload',
    Commitment: 'macp.v1.CommitmentPayload',
    Signal: 'macp.v1.SignalPayload',
    Progress: 'macp.v1.ProgressPayload'
  },
  'macp.mode.decision.v1': {
    Proposal: 'macp.modes.decision.v1.ProposalPayload',
    Evaluation: 'macp.modes.decision.v1.EvaluationPayload',
    Objection: 'macp.modes.decision.v1.ObjectionPayload',
    Vote: 'macp.modes.decision.v1.VotePayload'
  },
  'macp.mode.proposal.v1': {
    Proposal: 'macp.modes.proposal.v1.ProposalPayload',
    CounterProposal: 'macp.modes.proposal.v1.CounterProposalPayload',
    Accept: 'macp.modes.proposal.v1.AcceptPayload',
    Reject: 'macp.modes.proposal.v1.RejectPayload',
    Withdraw: 'macp.modes.proposal.v1.WithdrawPayload'
  },
  'macp.mode.task.v1': {
    TaskRequest: 'macp.modes.task.v1.TaskRequestPayload',
    TaskAccept: 'macp.modes.task.v1.TaskAcceptPayload',
    TaskReject: 'macp.modes.task.v1.TaskRejectPayload',
    TaskUpdate: 'macp.modes.task.v1.TaskUpdatePayload',
    TaskComplete: 'macp.modes.task.v1.TaskCompletePayload',
    TaskFail: 'macp.modes.task.v1.TaskFailPayload'
  },
  'macp.mode.handoff.v1': {
    HandoffOffer: 'macp.modes.handoff.v1.HandoffOfferPayload',
    HandoffContext: 'macp.modes.handoff.v1.HandoffContextPayload',
    HandoffAccept: 'macp.modes.handoff.v1.HandoffAcceptPayload',
    HandoffDecline: 'macp.modes.handoff.v1.HandoffDeclinePayload'
  },
  'macp.mode.quorum.v1': {
    ApprovalRequest: 'macp.modes.quorum.v1.ApprovalRequestPayload',
    Approve: 'macp.modes.quorum.v1.ApprovePayload',
    Reject: 'macp.modes.quorum.v1.RejectPayload',
    Abstain: 'macp.modes.quorum.v1.AbstainPayload'
  },
  'ext.multi_round.v1': {
    Contribute: '__json__'
  }
};

@Injectable()
export class ProtoRegistryService implements OnModuleInit {
  private readonly logger = new Logger(ProtoRegistryService.name);
  private root!: protobuf.Root;

  onModuleInit(): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { protoDir: protoRoot } = require('@multiagentcoordinationprotocol/proto');
    const protoFiles = [
      path.join(protoRoot, 'macp/v1/core.proto'),
      path.join(protoRoot, 'macp/v1/envelope.proto'),
      path.join(protoRoot, 'macp/modes/decision/v1/decision.proto'),
      path.join(protoRoot, 'macp/modes/proposal/v1/proposal.proto'),
      path.join(protoRoot, 'macp/modes/task/v1/task.proto'),
      path.join(protoRoot, 'macp/modes/handoff/v1/handoff.proto'),
      path.join(protoRoot, 'macp/modes/quorum/v1/quorum.proto')
    ];

    try {
      this.root = new protobuf.Root();
      this.root.resolvePath = (_origin: string, target: string) => {
        return path.isAbsolute(target) ? target : path.join(protoRoot, target);
      };
      this.root.loadSync(protoFiles);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`failed to load proto definitions: ${message}. Files: ${protoFiles.join(', ')}`);
      throw error;
    }

    const missingTypes: string[] = [];
    for (const [mode, types] of Object.entries(MESSAGE_TYPE_MAP)) {
      for (const [msgType, typeName] of Object.entries(types)) {
        if (typeName === '__json__') continue; // Extension modes use JSON, no proto type
        try {
          this.root.lookupType(typeName);
        } catch {
          missingTypes.push(`${mode}/${msgType} -> ${typeName}`);
        }
      }
    }
    if (missingTypes.length > 0) {
      this.logger.warn(`proto types not found: ${missingTypes.join(', ')}`);
    }
  }

  decodeKnown(modeName: string, messageType: string, payload: Buffer): Record<string, unknown> | undefined {
    const typeName = MESSAGE_TYPE_MAP[modeName]?.[messageType] ?? MESSAGE_TYPE_MAP.__core__[messageType];
    if (!typeName) {
      return this.tryDecodeUtf8(payload);
    }
    // Extension modes using JSON payloads (no proto definition)
    if (typeName === '__json__') {
      return this.tryDecodeUtf8(payload);
    }
    // Try proto decode first (real Rust runtime). If the bytes aren't valid proto
    // (e.g. mock runtime sends JSON), fall back to UTF-8/JSON parsing rather than
    // throwing — the normalizer must be resilient to either wire format.
    try {
      return this.decodeMessage(typeName, payload);
    } catch {
      return this.tryDecodeUtf8(payload);
    }
  }

  decodeMessage(typeName: string, payload: Buffer): Record<string, unknown> {
    const type = this.lookupType(typeName);
    const decoded = type.decode(payload);
    return type.toObject(decoded, {
      enums: String,
      bytes: String,
      longs: Number,
      defaults: false
    }) as Record<string, unknown>;
  }

  getKnownTypeName(modeName: string, messageType: string): string | undefined {
    return MESSAGE_TYPE_MAP[modeName]?.[messageType] ?? MESSAGE_TYPE_MAP.__core__[messageType];
  }

  private lookupType(typeName: string): protobuf.Type {
    const lookedUp = this.root.lookupType(typeName);
    if (!(lookedUp instanceof protobuf.Type)) {
      throw new Error(`protobuf type '${typeName}' not found`);
    }
    return lookedUp;
  }

  private tryDecodeUtf8(payload: Buffer): Record<string, unknown> | undefined {
    if (payload.length === 0) return undefined;
    const utf8 = payload.toString('utf8');
    try {
      const parsed = JSON.parse(utf8) as Record<string, unknown>;
      return { json: parsed, encoding: 'json' };
    } catch {
      return { text: utf8, encoding: 'text', payloadBase64: payload.toString('base64') };
    }
  }
}
