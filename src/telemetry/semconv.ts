/**
 * OpenTelemetry attribute names (macp-semconv/0.1).
 *
 * Registry names come from the spec's `schemas/otel/macp-semconv.json`
 * (explained by `docs/opentelemetry.md`). Names the registry does not define are
 * control-plane specific and live under `macp.cp.*`, as the doc's
 * "Implementation-specific attributes" rule requires.
 *
 * Privacy (docs/opentelemetry.md "Privacy"): identifiers and types only. Never
 * put Envelope payloads, free text such as `reason`, or commitment content into
 * an attribute.
 */

/** Registry attributes (`registry.macp` in macp-semconv.json). */
export const MACP_ATTR = {
  SESSION_ID: 'macp.session.id',
  MESSAGE_ID: 'macp.message.id',
  MESSAGE_TYPE: 'macp.message.type',
  MODE_ID: 'macp.mode.id',
  SENDER_ID: 'macp.sender.id',
  SESSION_STATE: 'macp.session.state'
} as const;

/** Control-plane attributes, outside the registry (`macp.cp.*`). */
export const MACP_CP_ATTR = {
  RUN_ID: 'macp.cp.run.id',
  RUNTIME_KIND: 'macp.cp.runtime.kind',
  EXECUTION_MODE: 'macp.cp.execution.mode',
  RAW_EVENT_KIND: 'macp.cp.raw_event.kind',
  EVENT_COUNT: 'macp.cp.event.count',
  RUN_TERMINAL_STATUS: 'macp.cp.run.terminal_status',
  // Span-event (annotation) attributes on the run span.
  EVENT_SEQ: 'macp.cp.event.seq',
  SIGNAL_TYPE: 'macp.cp.signal.type',
  SIGNAL_ID: 'macp.cp.signal.id',
  COMMITMENT_OUTCOME_POSITIVE: 'macp.cp.commitment.outcome_positive'
} as const;

/** Reused OpenTelemetry names (`registry.macp.reused`). `error.type` carries the MACPError code. */
export const OTEL_ATTR = {
  ERROR_TYPE: 'error.type'
} as const;

/**
 * Pre-semconv names, dual-emitted for ONE release (control plane 0.8.x) so
 * dashboards and alerts keyed on them keep working while they migrate. Delete
 * this map, and `withLegacyAttributes`' body, in the release after.
 */
export const LEGACY_ATTRIBUTE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  [MACP_ATTR.SESSION_ID]: ['session_id', 'macp.session_id'],
  [MACP_ATTR.MESSAGE_TYPE]: ['macp.message_type'],
  [MACP_ATTR.MODE_ID]: ['mode_name'],
  [MACP_CP_ATTR.RUN_ID]: ['run_id'],
  [MACP_CP_ATTR.RUNTIME_KIND]: ['runtime_kind'],
  [MACP_CP_ATTR.EXECUTION_MODE]: ['execution_mode'],
  [MACP_CP_ATTR.RAW_EVENT_KIND]: ['macp.raw_kind'],
  [MACP_CP_ATTR.EVENT_COUNT]: ['macp.event_count'],
  [MACP_CP_ATTR.RUN_TERMINAL_STATUS]: ['run.terminal_status']
};

/**
 * Pre-semconv names of the run-span annotation attributes (`RunEventService`
 * key-event span events), dual-emitted for the same one release. Kept apart from
 * the span map so `sender` etc. never appear on spans that did not carry them.
 */
export const LEGACY_SPAN_EVENT_ATTRIBUTE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  [MACP_CP_ATTR.EVENT_SEQ]: ['seq'],
  [MACP_CP_ATTR.SIGNAL_TYPE]: ['name'],
  [MACP_CP_ATTR.SIGNAL_ID]: ['signalId'],
  [MACP_ATTR.SENDER_ID]: ['sender'],
  [OTEL_ATTR.ERROR_TYPE]: ['errorCode'],
  [MACP_CP_ATTR.COMMITMENT_OUTCOME_POSITIVE]: ['outcome']
};

export type SpanAttributeValue = string | number | boolean;

/**
 * Drop undefined values and add each new name's legacy alias(es) with the same
 * value. The new name is always emitted; the alias only accompanies it.
 */
export function withLegacyAttributes(
  attributes: Record<string, SpanAttributeValue | undefined>,
  aliases: Readonly<Record<string, readonly string[]>> = LEGACY_ATTRIBUTE_ALIASES
): Record<string, SpanAttributeValue> {
  const out: Record<string, SpanAttributeValue> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    out[key] = value;
    for (const alias of aliases[key] ?? []) out[alias] = value;
  }
  return out;
}
