-- Rename the canonical event source discriminant from the legacy
-- 'control-plane' value to the fully-qualified 'macp-control-plane'.
-- Producers now emit 'macp-control-plane'; this rewrites historical rows so
-- reads, projections, and replay are consistent on the wire. The application
-- read path (replay) also normalizes any stragglers via
-- normalizeEventSourceKind, so this migration is idempotent and safe to re-run.
UPDATE run_events_canonical
SET source_kind = 'macp-control-plane'
WHERE source_kind = 'control-plane';
