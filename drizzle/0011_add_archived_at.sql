-- Add archived_at timestamp to runs table for proper archive tracking.
-- Previously, archiving was tracked only via the 'archived' tag in the tags array.
-- This column provides a proper timestamp for when the archive happened.
ALTER TABLE runs ADD COLUMN archived_at TIMESTAMPTZ DEFAULT NULL;

-- Backfill: set archived_at for already-archived runs (using updated_at as best approximation)
UPDATE runs SET archived_at = updated_at WHERE tags @> '["archived"]'::jsonb AND archived_at IS NULL;
