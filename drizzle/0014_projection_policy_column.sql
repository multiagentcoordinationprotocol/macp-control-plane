-- Add policy projection column to run_projections.
--
-- The projection.policy block was previously dropped at persist time because
-- ProjectionRepository.upsert had no column to write it to. This caused the
-- T2C policy.quorumStatus derivation (and any other policy projection field)
-- to be invisible in the run state response. Adding a dedicated jsonb column
-- so the policy projection survives the read-modify-write cycle.
--
-- Default mirrors the in-memory shape ProjectionService.empty() returns when
-- no events have populated the policy projection yet.

ALTER TABLE run_projections
  ADD COLUMN IF NOT EXISTS policy jsonb NOT NULL DEFAULT '{"policyVersion": "", "commitmentEvaluations": []}'::jsonb;
