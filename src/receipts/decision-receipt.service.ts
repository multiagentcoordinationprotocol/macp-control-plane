import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { RuntimeProvider } from '../contracts/runtime';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { RunManagerService } from '../runs/run-manager.service';
import { RuntimeCapabilitiesService } from '../runtime/runtime-capabilities.service';
import { RuntimeProviderRegistry } from '../runtime/runtime-provider.registry';

/** How long `GET /runtime/receipt-keys` reuses a key set, here and in `Cache-Control`. */
export const RECEIPT_KEYS_TTL_SECONDS = 60;

export interface DecisionReceiptView {
  runId: string;
  sessionId: string;
  /** The runtime's receipt JSON text, verbatim. Verify signatures over THIS, never a re-serialization. */
  receiptJson: string;
  /** `receiptJson` parsed, for display. */
  receipt: Record<string, unknown>;
}

export interface ReceiptKeysView {
  /** The runtime's JWK Set JSON text, verbatim. */
  jwksJson: string;
  /** Seconds the caller may reuse it. */
  maxAgeSeconds: number;
}

interface CachedKeys {
  jwksJson: string;
  kids: Set<string>;
  expiresAt: number;
}

/**
 * Proxies the runtime's decision-receipt RPCs (RFC-MACP-0013 §13): `GetDecisionReceipt` for a run's
 * session and `GetReceiptKeys` for the JWK Set that verifies receipt signatures. Read-only and
 * stateless apart from a short key-set cache. The control plane does not verify receipts itself:
 * it hands the verbatim JSON to the caller, who verifies against the key set (A.4).
 *
 * Mirrors `WhatIfReplayService`: resolve the run's `runtimeSessionId`, gate on a capability read that
 * re-runs Initialize when the cached capabilities do not advertise the feature (so a runtime upgraded
 * since run start is seen without a restart), and let the runtime's registry code pick the status.
 */
@Injectable()
export class DecisionReceiptService {
  private readonly keyCache = new Map<string, CachedKeys>();

  constructor(
    private readonly config: AppConfigService,
    private readonly runManager: RunManagerService,
    private readonly runtimeRegistry: RuntimeProviderRegistry,
    private readonly capabilities: RuntimeCapabilitiesService
  ) {}

  async getReceipt(runId: string): Promise<DecisionReceiptView> {
    const run = await this.findRun(runId);
    const sessionId = run.runtimeSessionId;
    if (!sessionId) {
      throw new AppException(ErrorCode.NOT_FOUND, `run ${runId} has no runtime session yet`, HttpStatus.NOT_FOUND);
    }
    const provider = this.runtimeRegistry.get(run.runtimeKind);
    await this.assertSupported(provider);

    // RECEIPT_UNAVAILABLE → 409, SESSION_NOT_FOUND → 404, FORBIDDEN → 403 via MACP_ERROR_REGISTRY.
    const { receiptJson } = await provider.getDecisionReceipt({ runtimeSessionId: sessionId });
    const receipt = parseObject(receiptJson, 'GetDecisionReceipt receipt_json');

    // A receipt signed with a key the cached set does not hold (a rotation inside the TTL) must
    // not leave the caller with "unknown key" for up to a TTL: drop the cache so the next keys
    // read asks the runtime.
    const cached = this.keyCache.get(run.runtimeKind);
    if (cached && signingKids(receipt).some((kid) => !cached.kids.has(kid))) {
      this.keyCache.delete(run.runtimeKind);
    }

    return { runId, sessionId, receiptJson, receipt };
  }

  async getReceiptKeys(): Promise<ReceiptKeysView> {
    const kind = this.config.runtimeKind;
    const now = Date.now();
    const cached = this.keyCache.get(kind);
    if (cached && cached.expiresAt > now) {
      return { jwksJson: cached.jwksJson, maxAgeSeconds: Math.max(0, Math.ceil((cached.expiresAt - now) / 1000)) };
    }

    const provider = this.runtimeRegistry.get(kind);
    await this.assertSupported(provider);
    const { jwksJson } = await provider.getReceiptKeys();
    const jwks = parseObject(jwksJson, 'GetReceiptKeys jwks_json');
    if (!Array.isArray(jwks.keys)) {
      throw badGateway('GetReceiptKeys jwks_json is not a JWK Set (no "keys" array)');
    }
    const kids = new Set(
      jwks.keys
        .map((k) => (k && typeof k === 'object' ? (k as { kid?: unknown }).kid : undefined))
        .filter((kid): kid is string => typeof kid === 'string')
    );
    this.keyCache.set(kind, { jwksJson, kids, expiresAt: now + RECEIPT_KEYS_TTL_SECONDS * 1000 });
    return { jwksJson, maxAgeSeconds: RECEIPT_KEYS_TTL_SECONDS };
  }

  /** §13 item 1: a client MUST NOT call either RPC unless the runtime advertises it. */
  private async assertSupported(provider: RuntimeProvider): Promise<void> {
    const capabilities = await this.capabilities.forDecisionReceipt(provider);
    if (capabilities?.decisionReceipt?.getDecisionReceipt !== true) {
      throw new AppException(
        ErrorCode.DECISION_RECEIPT_UNSUPPORTED,
        'runtime does not advertise decisionReceipt.getDecisionReceipt (requires macp-runtime >= 0.11)',
        HttpStatus.NOT_IMPLEMENTED
      );
    }
  }

  /** Coded (`RUN_NOT_FOUND`) so every receipt error a client branches on carries an `errorCode`. */
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
}

function parseObject(text: string, what: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw badGateway(`${what} is not valid JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badGateway(`${what} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

function badGateway(message: string): AppException {
  return new AppException(ErrorCode.INTERNAL_ERROR, message, HttpStatus.BAD_GATEWAY);
}

/** `kid`s from the receipt's `jws` attestations' protected headers (A.3); unreadable ones are skipped. */
function signingKids(receipt: Record<string, unknown>): string[] {
  const attestations = Array.isArray(receipt.attestations) ? receipt.attestations : [];
  const kids: string[] = [];
  for (const a of attestations) {
    const jws = a && typeof a === 'object' ? (a as { jws?: unknown }).jws : undefined;
    if (typeof jws !== 'string') continue;
    try {
      const header = JSON.parse(Buffer.from(jws.split('.')[0], 'base64url').toString('utf8')) as { kid?: unknown };
      if (typeof header.kid === 'string') kids.push(header.kid);
    } catch {
      // not a readable compact JWS; the verifier will say so
    }
  }
  return kids;
}
