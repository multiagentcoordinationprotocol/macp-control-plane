/* eslint-disable @typescript-eslint/no-explicit-any -- gRPC dynamic proto loading returns untyped objects */
import { HttpStatus } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import { context, propagation } from '@opentelemetry/api';
import { RuntimeAck, RuntimeEnvelope, RuntimeSessionSnapshot } from '../contracts/runtime';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';

/**
 * Marshalling helpers extracted from `rust-runtime.provider.ts` (Q3-1).
 *
 * Intentionally pure functions — no DI, no state. Keeping them here makes the
 * provider class itself focused on the RPC entry points and the subscribe-session
 * event loop.
 */

/** gRPC envelope → internal `RuntimeEnvelope`. */
export function fromEnvelope(envelope: any): RuntimeEnvelope {
  return {
    macpVersion: envelope.macpVersion,
    mode: envelope.mode,
    messageType: envelope.messageType,
    messageId: envelope.messageId,
    sessionId: envelope.sessionId,
    sender: envelope.sender,
    timestampUnixMs: Number(envelope.timestampUnixMs ?? Date.now()),
    payload: Buffer.isBuffer(envelope.payload) ? envelope.payload : Buffer.from(envelope.payload ?? '')
  };
}

/**
 * A runtime policy denial's structured detail — the JSON the runtime writes to
 * `MACPError.details` and the `macp-error-details-bin` status trailer:
 * `{ reasons: string[], denials: [{ code, message, participants }] }`
 * (macp-runtime `error_details_bytes`; `denials` since v0.9.0).
 */
export interface PolicyDenyDetails {
  reasons?: string[];
  denials?: Array<Record<string, unknown>>;
}

/**
 * Decode policy-deny detail bytes. Returns `undefined` for empty/absent bytes,
 * malformed JSON or a non-object — never throws, because the detail is
 * best-effort enrichment of an error that is already being reported.
 */
export function parsePolicyDenyDetails(bytes: Buffer | Uint8Array | string | undefined): PolicyDenyDetails | undefined {
  if (bytes === undefined || bytes === null || bytes.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes as Uint8Array).toString('utf-8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { reasons, denials } = parsed as { reasons?: unknown; denials?: unknown };
  const out: PolicyDenyDetails = {};
  if (Array.isArray(reasons) && reasons.every((r) => typeof r === 'string')) out.reasons = reasons;
  if (Array.isArray(denials) && denials.every((d) => typeof d === 'object' && d !== null)) {
    out.denials = denials as Array<Record<string, unknown>>;
  }
  return out.reasons || out.denials ? out : undefined;
}

/** First `macp-error-details-bin` trailer value, if any. */
function detailsBinFrom(metadata: grpc.Metadata | undefined): Buffer | undefined {
  const values = metadata?.get?.('macp-error-details-bin');
  return values && values.length > 0 ? Buffer.from(values[0] as Buffer) : undefined;
}

/**
 * gRPC ack → internal `RuntimeAck`. Extracts structured `reasons`/`denials`
 * from the error's details bytes, falling back to the trailing metadata.
 */
export function fromAck(ack: any, trailingMetadata?: grpc.Metadata): RuntimeAck {
  const deny = parsePolicyDenyDetails(ack?.error?.details) ?? parsePolicyDenyDetails(detailsBinFrom(trailingMetadata));
  const reasons = deny?.reasons;
  const denials = deny?.denials;

  return {
    ok: Boolean(ack?.ok),
    duplicate: Boolean(ack?.duplicate),
    messageId: ack?.messageId ?? '',
    sessionId: ack?.sessionId ?? '',
    acceptedAtUnixMs: Number(ack?.acceptedAtUnixMs ?? Date.now()),
    sessionState: (ack?.sessionState ?? 'SESSION_STATE_UNSPECIFIED') as RuntimeAck['sessionState'],
    error: ack?.error
      ? {
          code: ack.error.code,
          message: ack.error.message,
          sessionId: ack.error.sessionId,
          messageId: ack.error.messageId,
          detailsBase64: ack.error.details ? Buffer.from(ack.error.details).toString('base64') : undefined,
          details: ack.error.details ? Buffer.from(ack.error.details) : undefined,
          reasons,
          ...(denials ? { denials } : {})
        }
      : undefined
  };
}

/** gRPC session metadata → internal `RuntimeSessionSnapshot`. */
export function fromSessionMetadata(metadata: any): RuntimeSessionSnapshot {
  return {
    sessionId: metadata?.sessionId ?? '',
    mode: metadata?.mode ?? '',
    state: metadata?.state ?? 'SESSION_STATE_UNSPECIFIED',
    startedAtUnixMs: metadata?.startedAtUnixMs ? Number(metadata.startedAtUnixMs) : undefined,
    expiresAtUnixMs: metadata?.expiresAtUnixMs ? Number(metadata.expiresAtUnixMs) : undefined,
    modeVersion: metadata?.modeVersion,
    configurationVersion: metadata?.configurationVersion,
    policyVersion: metadata?.policyVersion,
    initiator: metadata?.initiator ?? undefined,
    // 0.1.6 SessionMetadata.context_id (12) / extension_keys (13). Carried through
    // to the projection so `state.run.contextId` / `extensionKeys` light up.
    contextId: metadata?.contextId || undefined,
    extensionKeys:
      Array.isArray(metadata?.extensionKeys) && metadata.extensionKeys.length > 0 ? metadata.extensionKeys : undefined
  };
}

/**
 * Build gRPC metadata from a credential map, injecting W3C trace context so
 * runtime-side spans become children of the active control-plane span —
 * unless gRPC auto-instrumentation is active, which injects it itself.
 */
export function buildMetadata(metadataInput: Record<string, string>): grpc.Metadata {
  const metadata = new grpc.Metadata();
  for (const [key, value] of Object.entries(metadataInput)) {
    if (value) metadata.set(key, value);
  }
  if (!isGrpcClientAutoInstrumented()) injectTraceContext(metadata);
  return metadata;
}

/**
 * True when `@opentelemetry/instrumentation-grpc` has patched the grpc-js client
 * (it shimmer-wraps the four `Client.prototype.make*Request` methods together,
 * marking each wrapper `__wrapped`). The instrumentation then opens a client span
 * per call and writes `traceparent`/`tracestate` into that call's metadata, so a
 * second, manual injection would only race it with the parent span's context.
 * Exactly one injector per outgoing call: the instrumentation when it is active,
 * {@link injectTraceContext} otherwise (for example when `OTEL_NODE_DISABLED_INSTRUMENTATIONS`
 * includes `grpc`, or grpc-js loaded before the SDK could patch it — the case today, since
 * `main.ts` imports `AppModule` before `startTelemetry`). Checked per call, so it follows
 * whichever is true at the time. Caveat: the instrumentation's `ignoreGrpcMethods` option
 * (not configured here) keeps the wrapper but skips injection for the listed methods.
 */
export function isGrpcClientAutoInstrumented(): boolean {
  const fn: unknown = grpc.Client.prototype.makeUnaryRequest;
  return typeof fn === 'function' && (fn as { __wrapped?: unknown }).__wrapped === true;
}

/** W3C trace context propagation via OTel API — traceparent + optional tracestate. */
export function injectTraceContext(metadata: grpc.Metadata): void {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  for (const [key, value] of Object.entries(carrier)) {
    if (value) metadata.set(key, value);
  }
}

/**
 * Resolve a client method by either PascalCase (the RPC name) or lowerCamelCase
 * (what some @grpc/grpc-js versions expose on dynamically-loaded clients).
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export function getClientMethod(client: any, method: string): Function {
  const direct = client[method];
  if (typeof direct === 'function') return direct;
  const lowerCamel = method.charAt(0).toLowerCase() + method.slice(1);
  const fallback = client[lowerCamel];
  if (typeof fallback === 'function') return fallback;
  throw new Error(`runtime gRPC method '${method}' is not available on client`);
}

/**
 * Translation table from a downstream gRPC status code to the HTTP status +
 * `ErrorCode` the control-plane should surface. Without this, every runtime
 * gRPC failure (PERMISSION_DENIED, NOT_FOUND, …) fell through the global
 * exception filter as an opaque HTTP 500, hiding the real cause from clients.
 * Any code not listed here maps to 500 (see `mapGrpcError`).
 *
 * Since runtime v0.9.0 this is only the fallback: a status carrying a known
 * `macp-error-code` maps through `MACP_ERROR_REGISTRY` instead, because several
 * registry codes share one gRPC status (S13). A 0.8.x runtime sends no code, so
 * this table is what keeps it working unchanged.
 */
const GRPC_STATUS_TO_HTTP: Partial<Record<grpc.status, { http: HttpStatus; code: ErrorCode }>> = {
  [grpc.status.INVALID_ARGUMENT]: { http: HttpStatus.BAD_REQUEST, code: ErrorCode.VALIDATION_ERROR },
  [grpc.status.OUT_OF_RANGE]: { http: HttpStatus.BAD_REQUEST, code: ErrorCode.VALIDATION_ERROR },
  [grpc.status.FAILED_PRECONDITION]: { http: HttpStatus.CONFLICT, code: ErrorCode.CONFLICT },
  [grpc.status.ABORTED]: { http: HttpStatus.CONFLICT, code: ErrorCode.CONFLICT },
  [grpc.status.ALREADY_EXISTS]: { http: HttpStatus.CONFLICT, code: ErrorCode.CONFLICT },
  [grpc.status.NOT_FOUND]: { http: HttpStatus.NOT_FOUND, code: ErrorCode.NOT_FOUND },
  [grpc.status.PERMISSION_DENIED]: { http: HttpStatus.FORBIDDEN, code: ErrorCode.FORBIDDEN },
  [grpc.status.UNAUTHENTICATED]: { http: HttpStatus.UNAUTHORIZED, code: ErrorCode.UNAUTHENTICATED },
  [grpc.status.RESOURCE_EXHAUSTED]: { http: HttpStatus.TOO_MANY_REQUESTS, code: ErrorCode.RATE_LIMITED },
  [grpc.status.UNIMPLEMENTED]: { http: HttpStatus.NOT_IMPLEMENTED, code: ErrorCode.NOT_IMPLEMENTED },
  [grpc.status.UNAVAILABLE]: { http: HttpStatus.SERVICE_UNAVAILABLE, code: ErrorCode.RUNTIME_UNAVAILABLE },
  [grpc.status.DEADLINE_EXCEEDED]: { http: HttpStatus.GATEWAY_TIMEOUT, code: ErrorCode.RUNTIME_TIMEOUT }
};

/**
 * The MACP error-codes registry (spec `registries/error-codes.md` @ `60262b8`,
 * mirrored from macp-runtime `crates/macp-core/src/error.rs`
 * `ERROR_CODE_REGISTRY`): registry code → the HTTP status + `ErrorCode` the
 * control plane surfaces. The HTTP column is the registry's, with one
 * deliberate divergence: `REGISTRY_READ_ONLY` stays **405** (registry: 409),
 * the status the control plane has returned since runtime v0.5.0 — clients
 * branch on `errorCode`, and 405 states "this method is disabled on this
 * deployment" (owner decision, 2026-10-18; see `DECISIONS.md`).
 */
export const MACP_ERROR_REGISTRY: Readonly<Record<string, { http: HttpStatus; code: ErrorCode }>> = {
  UNAUTHENTICATED: { http: HttpStatus.UNAUTHORIZED, code: ErrorCode.UNAUTHENTICATED },
  FORBIDDEN: { http: HttpStatus.FORBIDDEN, code: ErrorCode.FORBIDDEN },
  SESSION_NOT_FOUND: { http: HttpStatus.NOT_FOUND, code: ErrorCode.NOT_FOUND },
  SESSION_NOT_OPEN: { http: HttpStatus.CONFLICT, code: ErrorCode.SESSION_NOT_OPEN },
  DUPLICATE_MESSAGE: { http: HttpStatus.CONFLICT, code: ErrorCode.DUPLICATE_MESSAGE },
  SESSION_ALREADY_EXISTS: { http: HttpStatus.CONFLICT, code: ErrorCode.SESSION_ALREADY_EXISTS },
  INVALID_ENVELOPE: { http: HttpStatus.BAD_REQUEST, code: ErrorCode.INVALID_ENVELOPE },
  UNSUPPORTED_PROTOCOL_VERSION: { http: HttpStatus.BAD_REQUEST, code: ErrorCode.VALIDATION_ERROR },
  MODE_NOT_SUPPORTED: { http: HttpStatus.BAD_REQUEST, code: ErrorCode.MODE_NOT_SUPPORTED },
  PAYLOAD_TOO_LARGE: { http: HttpStatus.PAYLOAD_TOO_LARGE, code: ErrorCode.PAYLOAD_TOO_LARGE },
  RATE_LIMITED: { http: HttpStatus.TOO_MANY_REQUESTS, code: ErrorCode.RATE_LIMITED },
  INVALID_SESSION_ID: { http: HttpStatus.BAD_REQUEST, code: ErrorCode.INVALID_SESSION_ID },
  INTERNAL_ERROR: { http: HttpStatus.INTERNAL_SERVER_ERROR, code: ErrorCode.INTERNAL_ERROR },
  UNKNOWN_POLICY_VERSION: { http: HttpStatus.NOT_FOUND, code: ErrorCode.UNKNOWN_POLICY_VERSION },
  POLICY_DENIED: { http: HttpStatus.FORBIDDEN, code: ErrorCode.POLICY_DENIED },
  INVALID_POLICY_DEFINITION: { http: HttpStatus.BAD_REQUEST, code: ErrorCode.INVALID_POLICY_DEFINITION },
  REGISTRY_READ_ONLY: { http: HttpStatus.METHOD_NOT_ALLOWED, code: ErrorCode.REGISTRY_READ_ONLY },
  INVALID_REQUEST: { http: HttpStatus.BAD_REQUEST, code: ErrorCode.VALIDATION_ERROR },
  // Retryable: the runtime dropped this consumer for falling behind (S13; owner decision Q2).
  STREAM_LAGGED: { http: HttpStatus.SERVICE_UNAVAILABLE, code: ErrorCode.STREAM_LAGGED },
  AGENT_NOT_FOUND: { http: HttpStatus.NOT_FOUND, code: ErrorCode.NOT_FOUND },
  // Permanent: WhatIfReplay on a session whose log was compacted (RFC-MACP-0012 1.8.1-draft).
  HISTORY_UNAVAILABLE: { http: HttpStatus.CONFLICT, code: ErrorCode.HISTORY_UNAVAILABLE },
  // Permanent: GetDecisionReceipt on a session that has no receipt to issue (RFC-MACP-0013 §13 item 3).
  RECEIPT_UNAVAILABLE: { http: HttpStatus.CONFLICT, code: ErrorCode.RECEIPT_UNAVAILABLE },
  // Deprecated registry alias for FORBIDDEN; the runtime never emits it.
  UNAUTHORIZED: { http: HttpStatus.FORBIDDEN, code: ErrorCode.FORBIDDEN }
};

/** Narrow an unknown thrown value to a gRPC `ServiceError` (numeric `.code`). */
function isGrpcServiceError(error: unknown): error is grpc.ServiceError {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'number';
}

/**
 * The registry code a runtime >= v0.9.0 attaches to every gRPC status as
 * `macp-error-code` ASCII metadata (S13). `undefined` for a 0.8.x runtime, a
 * non-runtime failure (e.g. a client-side deadline) or anything not a gRPC
 * error.
 */
export function readMacpErrorCode(error: unknown): string | undefined {
  const metadata = (error as { metadata?: unknown } | null | undefined)?.metadata;
  if (!(metadata instanceof grpc.Metadata)) return undefined;
  const value = metadata.get('macp-error-code')[0];
  if (value === undefined) return undefined;
  const code = (typeof value === 'string' ? value : Buffer.from(value).toString('ascii')).trim();
  return code.length > 0 ? code : undefined;
}

/**
 * The registry code carried by an error after `mapGrpcError` translated it
 * (`AppException.metadata.macpErrorCode`), or read straight off a raw
 * `ServiceError`. The one accessor downstream branches (run-failure
 * classification, poll retry, read-only registry, page-size back-off) use.
 */
export function macpErrorCodeOf(error: unknown): string | undefined {
  if (error instanceof AppException) {
    const code = error.metadata?.macpErrorCode;
    return typeof code === 'string' ? code : undefined;
  }
  return readMacpErrorCode(error);
}

/**
 * Map a thrown gRPC `ServiceError` to an `AppException` carrying the right HTTP
 * status and a client-readable message. Returns `undefined` for anything that
 * isn't a gRPC error so callers can rethrow it unchanged (and let the global
 * filter handle it as a 500). The runtime's human-readable `details` string is
 * preserved as the message — e.g. "only the session initiator or
 * policy-delegated roles can suspend".
 *
 * A status carrying a known `macp-error-code` maps by that code
 * (`MACP_ERROR_REGISTRY`); an absent or unrecognised code falls back to the
 * status-only table. `metadata` always holds `grpcCode`, plus `macpErrorCode`
 * whenever the runtime sent one, plus the decoded `reasons`/`denials` for a
 * `POLICY_DENIED`.
 */
export function mapGrpcError(error: unknown, method: string): AppException | undefined {
  if (!isGrpcServiceError(error)) return undefined;
  const message = error.details || error.message || `runtime ${method} failed`;
  const macpErrorCode = readMacpErrorCode(error);
  const metadata: Record<string, unknown> = { grpcCode: error.code };
  if (macpErrorCode) metadata.macpErrorCode = macpErrorCode;

  const mapping =
    (macpErrorCode && Object.prototype.hasOwnProperty.call(MACP_ERROR_REGISTRY, macpErrorCode)
      ? MACP_ERROR_REGISTRY[macpErrorCode]
      : undefined) ?? GRPC_STATUS_TO_HTTP[error.code as grpc.status];

  if (macpErrorCode === 'POLICY_DENIED') {
    const deny = parsePolicyDenyDetails(detailsBinFrom(error.metadata));
    if (deny?.reasons) metadata.reasons = deny.reasons;
    if (deny?.denials) metadata.denials = deny.denials;
  }

  if (!mapping) {
    return new AppException(ErrorCode.INTERNAL_ERROR, message, HttpStatus.INTERNAL_SERVER_ERROR, metadata);
  }
  return new AppException(mapping.code, message, mapping.http, metadata);
}
