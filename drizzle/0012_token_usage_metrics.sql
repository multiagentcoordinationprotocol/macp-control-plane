-- Add token usage and cost tracking columns to run_metrics.
-- Agents include tokenUsage in message metadata; control plane extracts and accumulates.
ALTER TABLE run_metrics ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE run_metrics ADD COLUMN completion_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE run_metrics ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE run_metrics ADD COLUMN estimated_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0;
