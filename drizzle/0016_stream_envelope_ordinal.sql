-- T7 (runtime v0.5.0 stream resume): track the 1-based accepted-envelope
-- ordinal delivered on each run's per-session StreamSession. This is the
-- runtime's `after_sequence` value (stable across compaction, exclusive) and is
-- distinct from `last_stream_cursor` (the CP-side canonical event seq). On a
-- stream disconnect the consumer resubscribes with `after_sequence` = this
-- ordinal to resume without re-ingesting history. Nullable-safe default 0 so
-- existing rows resume from the start (harmless — the subscribe-window dedup
-- fix means a from-0 replay produces no duplicate canonical events).
ALTER TABLE runtime_sessions ADD COLUMN IF NOT EXISTS last_envelope_ordinal INTEGER NOT NULL DEFAULT 0;
