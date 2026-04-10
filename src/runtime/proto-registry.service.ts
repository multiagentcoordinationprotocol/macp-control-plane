import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as path from 'node:path';
import * as protobuf from 'protobufjs';
import { PayloadEnvelopeInput } from '../contracts/control-plane';

const MESSAGE_TYPE_MAP: Record<string, Record<string, string>> = {
  '__core__': {
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

  encodeSessionContext(context?: Record<string, unknown>, contextEnvelope?: PayloadEnvelopeInput): Buffer {
    if (contextEnvelope) return this.encodePayloadEnvelope(contextEnvelope);
    if (!context) return Buffer.alloc(0);
    return Buffer.from(JSON.stringify(context), 'utf8');
  }

  encodePayloadEnvelope(input: PayloadEnvelopeInput): Buffer {
    switch (input.encoding) {
      case 'json':
        return Buffer.from(JSON.stringify(input.json ?? {}), 'utf8');
      case 'text':
        return Buffer.from(input.text ?? '', 'utf8');
      case 'base64':
        return Buffer.from(input.base64 ?? '', 'base64');
      case 'proto': {
        if (!input.proto) throw new Error('proto payload envelope requires proto value');
        return this.encodeMessage(input.proto.typeName, input.proto.value);
      }
      default:
        throw new Error(`unsupported payload encoding ${(input as PayloadEnvelopeInput).encoding}`);
    }
  }

  encodeMessage(typeName: string, value: Record<string, unknown>): Buffer {
    const type = this.lookupType(typeName);
    const normalized = this.normalizeProtoValue(value) as Record<string, unknown>;
    const message = type.fromObject(normalized);
    return Buffer.from(type.encode(message).finish());
  }

  private normalizeProtoValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.normalizeProtoValue(item));
    }

    if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) {
      return value;
    }

    const normalized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const normalizedEntry = this.normalizeProtoValue(entry);
      const normalizedKey = key.includes('_')
        ? key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase())
        : key;
      normalized[normalizedKey] = normalizedEntry;
    }
    return normalized;
  }

  decodeKnown(modeName: string, messageType: string, payload: Buffer): Record<string, unknown> | undefined {
    const typeName =
      MESSAGE_TYPE_MAP[modeName]?.[messageType] ?? MESSAGE_TYPE_MAP.__core__[messageType];
    if (!typeName) {
      return this.tryDecodeUtf8(payload);
    }
    // Extension modes using JSON payloads (no proto definition)
    if (typeName === '__json__') {
      return this.tryDecodeUtf8(payload);
    }
    return this.decodeMessage(typeName, payload);
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
