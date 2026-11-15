-- Modules that failed, or finished without some of their inputs, in a run. The worker retries them with
-- backoff and writes an improved result into that run; after the last attempt the row is kept as 'dead'.
CREATE TABLE module_retries (
  symbol          text NOT NULL,
  module          text NOT NULL,
  run_id          uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','dead')),
  attempts        integer NOT NULL DEFAULT 0,
  reason          text NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, module)
);
CREATE INDEX module_retries_due_idx ON module_retries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX module_retries_run_idx ON module_retries (run_id);
ALTER TABLE module_retries ENABLE ROW LEVEL SECURITY;
