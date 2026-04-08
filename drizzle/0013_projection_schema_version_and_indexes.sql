-- Add schema version tracking to projections for migration detection.
ALTER TABLE run_projections ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;

-- Add missing indexes for query performance.
CREATE INDEX IF NOT EXISTS runs_mode_idx ON runs (mode);
CREATE INDEX IF NOT EXISTS runtime_sessions_initiator_idx ON runtime_sessions (initiator_participant_id);
CREATE INDEX IF NOT EXISTS run_events_canonical_run_created_idx ON run_events_canonical (run_id, created_at);
