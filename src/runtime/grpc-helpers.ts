/* eslint-disable @typescript-eslint/no-explicit-any -- gRPC dynamic proto loading returns untyped objects */
import * as grpc from '@grpc/grpc-js';
import { context, propagation } from '@opentelemetry/api';
import { RuntimeAck, RuntimeEnvelope, RuntimeSessionSnapshot } from '../contracts/runtime';

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

/** gRPC ack → internal `RuntimeAck`. Extracts structured `reasons` from details bytes or trailing metadata. */
export function fromAck(ack: any, trailingMetadata?: grpc.Metadata): RuntimeAck {
  let reasons: string[] | undefined;

  if (ack?.error?.details) {
    try {
      const parsed = JSON.parse(Buffer.from(ack.error.details).toString('utf-8'));
      if (Array.isArray(parsed.reasons)) reasons = parsed.reasons;
    } catch {
      /* ignore parse errors */
    }
  }

  if (!reasons && trailingMetadata) {
    const detailsBin = trailingMetadata.get('macp-error-details-bin');
    if (detailsBin && detailsBin.length > 0) {
      try {
        const parsed = JSON.parse(Buffer.from(detailsBin[0] as Buffer).toString('utf-8'));
        if (Array.isArray(parsed.reasons)) reasons = parsed.reasons;
      } catch {
        /* ignore parse errors */
      }
    }
  }

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
          reasons
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
    initiator: metadata?.initiator ?? undefined
  };
}

/**
 * Build gRPC metadata from a credential map, injecting W3C trace context so
 * runtime-side spans become children of the active control-plane span.
 */
export function buildMetadata(metadataInput: Record<string, string>): grpc.Metadata {
  const metadata = new grpc.Metadata();
  for (const [key, value] of Object.entries(metadataInput)) {
    if (value) metadata.set(key, value);
  }
  injectTraceContext(metadata);
  return metadata;
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
