-- API-owned additions. Additive only; safe to re-run.

-- Quiet hours for push: { "enabled": bool, "start": "HH:MM", "end": "HH:MM" } in Asia/Kolkata.
ALTER TABLE user_prefs ADD COLUMN IF NOT EXISTS quiet_hours jsonb;

-- Worker dispatch bookkeeping so queued runs whose GitHub dispatch was lost can be retried.
ALTER TABLE research_runs ADD COLUMN IF NOT EXISTS dispatched_at timestamptz;
ALTER TABLE research_runs ADD COLUMN IF NOT EXISTS dispatch_attempts int NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS research_runs_queued_idx ON research_runs (created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS research_runs_created_idx ON research_runs (created_at DESC);

-- Read/dismiss state lookups for the digest and holdings unread counts.
CREATE INDEX IF NOT EXISTS interactions_seq_idx ON interactions (seq_id, id DESC);
