import { Injectable } from '@nestjs/common';
import {
  commitmentHash,
  isCanonicalCommitmentHash,
  verifyCommitmentHash,
  type VerifyOutcome
} from 'macp-sdk-typescript';
import type { CommitmentPayload } from 'macp-sdk-typescript';
import { RunStateProjection } from '../contracts/control-plane';
import { RunManagerService } from '../runs/run-manager.service';
import { ProtoRegistryService } from '../runtime/proto-registry.service';
import { EventRepository } from '../storage/event.repository';

/** The one label RFC-MACP-0013 defines; it names the projection + preimage the hash is computed under. */
export const COMMITMENT_HASH_LABEL = 'macp-commitment-hash/1';

const COMMITMENT_TYPE = 'macp.v1.CommitmentPayload';

/**
 * `verified` — every check passed. `mismatch` — a check that could run disagreed.
 * `cannot_verify` — the Commitment exists but its wire bytes are outside what the label covers
 * (RFC-MACP-0013 §5/§6.1) or are not stored. `pending` — the run has no Commitment (yet).
 */
export type VerificationStatus = 'verified' | 'mismatch' | 'cannot_verify' | 'pending';

export interface VerificationCheck {
  id: 'wire_recompute' | 'rfc0013_verify' | 'projection_consistency' | 'supersedes_canonical';
  description: string;
  passed: boolean;
  detail?: string;
}

/** Section 3 projection of the Commitment: the exact field set the hash covers, in snake_case. */
export interface CommitmentProjection {
  commitment_id: string;
  action: string;
  authority_scope: string;
  reason: string;
  mode_version: string;
  policy_version: string;
  configuration_version: string;
  outcome_positive: boolean;
  supersedes?: { session_id: string; commitment_hash: string };
}

export interface RunVerification {
  runId: string;
  status: VerificationStatus;
  /** `commitmentHash === recomputed` and the §6.1 verifier returned `match`. */
  match: boolean;
  label: typeof COMMITMENT_HASH_LABEL;
  /** RFC-MACP-0013 hash of the CommitmentPayload as the control plane stored it (what the UI shows). */
  commitmentHash: string | null;
  /** RFC-MACP-0013 hash recomputed from the Commitment envelope's raw payload bytes, decoded afresh. */
  recomputed: string | null;
  /** RFC-MACP-0013 §6.1 verdict of the stored wire bytes against `commitmentHash`. */
  wireVerdict: VerifyOutcome | null;
  commitment: {
    messageId: string;
    sender: string;
    sessionId: string;
    acceptedAt: string;
    payload: CommitmentProjection;
  } | null;
  checks: VerificationCheck[];
  /** What this endpoint does not establish, so a reader does not over-read a green result. */
  notVerified: string[];
  checkedAt: string;
}

const NOT_VERIFIED = [
  'Authenticity: a commitment hash is a content digest, not a signature (RFC-MACP-0013 §12). No attestation is checked.',
  'Replay: the session is not re-executed; the hash is recomputed from the stored Commitment only.',
  'Runtime acceptance: the runtime does not report its own commitment hash, so there is no runtime-side value to compare against.'
];

function str(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

/** Normalize a stored payload (camelCase from protobufjs, or snake_case) to the SDK's CommitmentPayload. */
export function toCommitmentPayload(raw: Record<string, unknown>): CommitmentPayload {
  const pick = (camel: string, snake: string) => raw[camel] ?? raw[snake];
  const payload: CommitmentPayload = {
    commitmentId: str(pick('commitmentId', 'commitment_id')),
    action: str(raw.action),
    authorityScope: str(pick('authorityScope', 'authority_scope')),
    reason: str(raw.reason),
    modeVersion: str(pick('modeVersion', 'mode_version')),
    policyVersion: str(pick('policyVersion', 'policy_version')),
    configurationVersion: str(pick('configurationVersion', 'configuration_version')),
    outcomePositive: Boolean(pick('outcomePositive', 'outcome_positive'))
  };
  // A message-typed field: absent (undefined/null) is omitted; present-but-empty is kept (§3 rule 3).
  const sup = raw.supersedes;
  if (sup != null && typeof sup === 'object') {
    const ref = sup as Record<string, unknown>;
    payload.supersedes = {
      sessionId: str(ref.sessionId ?? ref.session_id),
      commitmentHash: str(ref.commitmentHash ?? ref.commitment_hash)
    };
  }
  return payload;
}

export function toProjection(p: CommitmentPayload): CommitmentProjection {
  return {
    commitment_id: p.commitmentId,
    action: p.action,
    authority_scope: p.authorityScope,
    reason: p.reason,
    mode_version: p.modeVersion,
    policy_version: p.policyVersion ?? '',
    configuration_version: p.configurationVersion,
    outcome_positive: p.outcomePositive ?? false,
    ...(p.supersedes
      ? { supersedes: { session_id: p.supersedes.sessionId, commitment_hash: p.supersedes.commitmentHash } }
      : {})
  };
}

/**
 * Audit check for a run's binding outcome (adoption roadmap W2.3). Recomputes the RFC-MACP-0013
 * canonical commitment hash of the run's Commitment two ways and cross-checks them:
 *
 * 1. from the CommitmentPayload the control plane stored when it normalized the envelope, and
 * 2. from the envelope's raw payload bytes, decoded afresh — then runs the RFC-MACP-0013 §6.1
 *    verifier on those bytes, which also rejects any field outside the frozen set.
 *
 * Hashing comes from `macp-sdk-typescript` (the reference Verifier implementation, tested against
 * the spec vectors), not a second copy. Read-only: nothing is persisted.
 */
@Injectable()
export class CommitmentVerificationService {
  constructor(
    private readonly runManager: RunManagerService,
    private readonly eventRepository: EventRepository,
    private readonly protoRegistry: ProtoRegistryService
  ) {}

  async verify(runId: string): Promise<RunVerification> {
    await this.runManager.getRun(runId); // 404 for an unknown run
    const checkedAt = new Date().toISOString();
    const base = {
      runId,
      label: COMMITMENT_HASH_LABEL,
      notVerified: NOT_VERIFIED,
      checkedAt
    } as const;

    const raw = await this.eventRepository.findLatestRawEnvelope(runId, 'Commitment');
    const envelope = (raw?.payload as { envelope?: Record<string, unknown> } | undefined)?.envelope;
    if (!raw || !envelope) {
      return {
        ...base,
        status: 'pending',
        match: false,
        commitmentHash: null,
        recomputed: null,
        wireVerdict: null,
        commitment: null,
        checks: []
      };
    }

    const messageId = str(envelope.messageId);
    const received = messageId ? await this.eventRepository.findReceivedMessage(runId, messageId) : undefined;
    const storedRaw = (received?.data as { payload?: Record<string, unknown> } | undefined)?.payload;

    const wire = typeof envelope.payloadBase64 === 'string' ? Buffer.from(envelope.payloadBase64, 'base64') : null;
    let wirePayload: CommitmentPayload | null = null;
    if (wire) {
      try {
        wirePayload = toCommitmentPayload(this.protoRegistry.decodeMessage(COMMITMENT_TYPE, wire));
      } catch {
        wirePayload = null;
      }
    }

    // The stored record is the primary source; when it is missing fall back to the wire decode so the
    // response still names the commitment, and let the cross-check below report the gap.
    const stored = storedRaw ? toCommitmentPayload(storedRaw) : null;
    const subject = stored ?? wirePayload;
    const storedHash = stored ? commitmentHash(stored) : null;
    const recomputed = wirePayload ? commitmentHash(wirePayload) : null;
    const wireVerdict: VerifyOutcome | null = wire && storedHash ? verifyCommitmentHash(wire, storedHash) : null;

    const checks: VerificationCheck[] = [
      {
        id: 'wire_recompute',
        description: 'Hash of the stored CommitmentPayload equals the hash recomputed from the envelope wire bytes',
        passed: storedHash !== null && storedHash === recomputed,
        ...(storedHash === null
          ? { detail: 'no stored message.received payload for this Commitment' }
          : recomputed === null
            ? { detail: 'the envelope payload bytes are missing or do not decode as a CommitmentPayload' }
            : {})
      },
      {
        id: 'rfc0013_verify',
        description: `RFC-MACP-0013 §6.1 verify of the wire bytes against that hash returns match (${COMMITMENT_HASH_LABEL})`,
        passed: wireVerdict === 'match',
        detail: wireVerdict ?? 'not run'
      }
    ];

    const state = await this.runManager.getState(runId).catch(() => undefined);
    const consistency = subject ? projectionConsistency(state, subject) : null;
    if (consistency) checks.push(consistency);

    if (subject?.supersedes) {
      checks.push({
        id: 'supersedes_canonical',
        description: 'supersedes.commitment_hash is in canonical sha256:<64 hex> form',
        passed: isCanonicalCommitmentHash(subject.supersedes.commitmentHash)
      });
    }

    const match = storedHash !== null && storedHash === recomputed && wireVerdict === 'match';
    const status: VerificationStatus =
      wireVerdict === 'cannot_verify' || (storedHash !== null && wire === null)
        ? 'cannot_verify'
        : match && checks.every((c) => c.passed)
          ? 'verified'
          : 'mismatch';

    return {
      ...base,
      status,
      match,
      commitmentHash: storedHash,
      recomputed,
      wireVerdict,
      commitment: subject
        ? {
            messageId,
            sender: str(envelope.sender),
            sessionId: str(envelope.sessionId),
            acceptedAt: raw.ts,
            payload: toProjection(subject)
          }
        : null,
      checks
    };
  }
}

/** The decision the run view displays must be the one that was hashed. */
function projectionConsistency(
  state: RunStateProjection | undefined,
  payload: CommitmentPayload
): VerificationCheck | null {
  const current = state?.decision?.current;
  if (!current?.finalized) return null;
  const mismatches: string[] = [];
  if (current.action !== payload.action) mismatches.push(`action ${JSON.stringify(current.action)}`);
  // proto3 drops `outcome_positive: false` from the decode, and the projection then infers the
  // outcome from the action — so only a committed `true` is a definite value to compare against.
  if (payload.outcomePositive === true && current.outcomePositive === false) {
    mismatches.push('outcomePositive false');
  }
  return {
    id: 'projection_consistency',
    description: 'The finalized decision shown for the run (action, outcome) matches the hashed Commitment',
    passed: mismatches.length === 0,
    ...(mismatches.length > 0 ? { detail: `projection differs: ${mismatches.join(', ')}` } : {})
  };
}
