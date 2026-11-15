-- Additive columns for the AI layer: cost-ledger detail, worker heartbeats and guidance withdrawal.

ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS prompt_version text;
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS attempt int;
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS ref_kind text;
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS ref_id text;
CREATE INDEX IF NOT EXISTS llm_calls_ref_idx ON llm_calls (ref_kind, ref_id);

ALTER TABLE research_runs ADD COLUMN IF NOT EXISTS worker_id text;
ALTER TABLE research_runs ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;
CREATE INDEX IF NOT EXISTS research_runs_status_idx ON research_runs (status, created_at);

ALTER TABLE guidance_items ADD COLUMN IF NOT EXISTS withdrawn boolean NOT NULL DEFAULT false;
ALTER TABLE guidance_items ADD COLUMN IF NOT EXISTS segment text;

ALTER TABLE module_cache ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'done';
