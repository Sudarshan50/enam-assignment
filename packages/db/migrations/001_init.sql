-- FINN schema v1. Every writer upserts on a natural key, so retried jobs are idempotent.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE companies (
  symbol            text PRIMARY KEY,
  name              text NOT NULL,
  isin              text,
  series            text,
  statement_family  text CHECK (statement_family IN ('industrial','banking','nbfc')),
  screener_slug     text,
  sector            text,
  shares_outstanding numeric,
  mcap_inr          numeric,
  mcap_at           date,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE holdings (
  symbol    text PRIMARY KEY REFERENCES companies(symbol) ON DELETE CASCADE,
  added_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE source_health (
  source                text PRIMARY KEY,
  last_success_at       timestamptz,
  last_attempt_at       timestamptz,
  consecutive_failures  int NOT NULL DEFAULT 0,
  last_error            text,
  records_last_run      int
);

CREATE TABLE ingestion_watermarks (
  source      text PRIMARY KEY,
  watermark   timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE announcements (
  seq_id        text PRIMARY KEY,
  symbol        text NOT NULL REFERENCES companies(symbol) ON DELETE CASCADE,
  headline      text NOT NULL,
  body_text     text,
  pdf_url       text,
  published_at  timestamptz NOT NULL,
  raw           jsonb NOT NULL,
  category      text,
  category_confidence real,
  category_source text CHECK (category_source IN ('rule','llm_text','llm_pdf','fallback')),
  score         real,
  reason_codes  text[] NOT NULL DEFAULT '{}',
  tier          text CHECK (tier IN ('act','know','noise')),
  cluster_key   text,
  parent_seq_id text REFERENCES announcements(seq_id) ON DELETE SET NULL,
  one_liner     text,
  card          jsonb,
  card_version  int NOT NULL DEFAULT 1,
  status        text NOT NULL DEFAULT 'raw' CHECK (status IN ('raw','classified','enriched','ready','failed','review')),
  error         text,
  attempts      int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX announcements_published_idx ON announcements (published_at DESC);
CREATE INDEX announcements_symbol_published_idx ON announcements (symbol, published_at DESC);
CREATE INDEX announcements_status_idx ON announcements (status, published_at DESC);
CREATE INDEX announcements_cluster_idx ON announcements (cluster_key);

-- ---------- Financials (exchange XBRL is the source of truth) ----------
CREATE TABLE quarterly_filings (
  seq_id            text PRIMARY KEY,
  symbol            text NOT NULL REFERENCES companies(symbol) ON DELETE CASCADE,
  period_start      date,
  period_end        date NOT NULL,
  basis             text NOT NULL CHECK (basis IN ('consolidated','standalone')),
  statement_family  text NOT NULL CHECK (statement_family IN ('industrial','banking','nbfc')),
  taxonomy          text NOT NULL,
  audited           boolean NOT NULL,
  revision          text,
  broadcast_at      timestamptz,
  xbrl_url          text NOT NULL,
  sha256            text,
  parser_version    int NOT NULL DEFAULT 1,
  status            text NOT NULL DEFAULT 'discovered' CHECK (status IN ('discovered','parsed','failed','under_review')),
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quarterly_filings_symbol_period_idx ON quarterly_filings (symbol, basis, period_end DESC);

CREATE TABLE financial_facts (
  filing_seq_id  text NOT NULL REFERENCES quarterly_filings(seq_id) ON DELETE CASCADE,
  concept        text NOT NULL,
  context        text NOT NULL CHECK (context IN ('OneD','FourD','OneI','PY_I')),
  period_start   date,
  period_end     date NOT NULL,
  value          numeric NOT NULL,
  unit           text NOT NULL DEFAULT 'INR',
  derived        boolean NOT NULL DEFAULT false,
  PRIMARY KEY (filing_seq_id, concept, context)
);

CREATE TABLE history_financials (
  symbol     text NOT NULL REFERENCES companies(symbol) ON DELETE CASCADE,
  statement  text NOT NULL CHECK (statement IN ('quarters','profit_loss','balance_sheet','cash_flow','ratios')),
  basis      text NOT NULL CHECK (basis IN ('consolidated','standalone')),
  periods    text[] NOT NULL,
  rows       jsonb NOT NULL,
  unit       text NOT NULL DEFAULT 'INR_CRORE',
  source     text NOT NULL DEFAULT 'screener',
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, statement, basis)
);

CREATE TABLE prices_eod (
  symbol        text NOT NULL,
  session_date  date NOT NULL,
  open          numeric,
  high          numeric,
  low           numeric,
  close         numeric NOT NULL,
  prev_close    numeric,
  volume        bigint,
  avg20_volume  numeric,
  source        text NOT NULL DEFAULT 'bhavcopy',
  PRIMARY KEY (symbol, session_date)
);

CREATE TABLE documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol          text NOT NULL REFERENCES companies(symbol) ON DELETE CASCADE,
  doc_type        text NOT NULL CHECK (doc_type IN ('annual_report','transcript','results_pdf','presentation','filing')),
  period_label    text NOT NULL,
  period_end      date,
  url             text NOT NULL,
  sha256          text,
  pages           int,
  text_quality    real,
  parser_version  int NOT NULL DEFAULT 1,
  status          text NOT NULL DEFAULT 'discovered'
                  CHECK (status IN ('discovered','downloaded','extracted','chunked','embedded','ready','failed','scanned')),
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (symbol, url)
);
CREATE INDEX documents_symbol_status_idx ON documents (symbol, status);

CREATE TABLE document_pages (
  document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page         int NOT NULL,
  text         text NOT NULL,
  PRIMARY KEY (document_id, page)
);

CREATE TABLE doc_chunks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id      uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index      int NOT NULL,
  symbol           text NOT NULL,
  page_start       int NOT NULL,
  page_end         int NOT NULL,
  section          text,
  text             text NOT NULL,
  token_estimate   int NOT NULL,
  tsv              tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, text)) STORED,
  embedding        halfvec(768),
  embedding_model  text,
  embedding_dims   int,
  UNIQUE (document_id, chunk_index)
);
CREATE INDEX doc_chunks_symbol_idx ON doc_chunks (symbol);
CREATE INDEX doc_chunks_tsv_idx ON doc_chunks USING gin (tsv);

-- ---------- Promise Ledger ----------
CREATE TABLE guidance_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol          text NOT NULL REFERENCES companies(symbol) ON DELETE CASCADE,
  document_id     uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_id        uuid REFERENCES doc_chunks(id) ON DELETE SET NULL,
  page            int,
  metric          text NOT NULL,
  statement_type  text NOT NULL CHECK (statement_type IN ('explicit_guidance','target','aspiration')),
  low             numeric,
  high            numeric,
  unit            text NOT NULL CHECK (unit IN ('pct','inr_crore','x')),
  horizon_label   text NOT NULL,
  horizon_start   date,
  horizon_end     date,
  scope           text NOT NULL DEFAULT 'consolidated',
  speaker         text,
  quote           text NOT NULL,
  said_in         text NOT NULL,
  said_on         date,
  extractor_version int NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, metric, horizon_label, quote)
);

CREATE TABLE guidance_checks (
  guidance_id    uuid PRIMARY KEY REFERENCES guidance_items(id) ON DELETE CASCADE,
  actual         numeric,
  actual_period  text,
  actual_source  text,
  verdict        text NOT NULL CHECK (verdict IN ('delivered','missed','pending','quietly_dropped','not_scored')),
  explanation    text NOT NULL,
  checked_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE research_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol        text NOT NULL,
  status        text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','processing_docs','synthesizing','completed','partial','failed','cancelled')),
  modules       text[] NOT NULL,
  input_hash    text,
  requested_by  text,
  claimed_at    timestamptz,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX research_runs_symbol_idx ON research_runs (symbol, created_at DESC);
CREATE UNIQUE INDEX research_runs_one_active_per_symbol
  ON research_runs (symbol) WHERE status IN ('queued','processing_docs','synthesizing');

CREATE TABLE research_events (
  id          bigserial PRIMARY KEY,
  run_id      uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  type        text NOT NULL,
  message     text NOT NULL,
  data        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX research_events_run_idx ON research_events (run_id, id);

CREATE TABLE research_modules (
  run_id      uuid NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  module      text NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','insufficient_sources')),
  payload     jsonb,
  cache_key   text,
  error       text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, module)
);

CREATE TABLE module_cache (
  cache_key   text PRIMARY KEY,
  symbol      text NOT NULL,
  module      text NOT NULL,
  payload     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alert_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  definition  jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alerts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id          uuid NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  symbol           text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('price_move','volume_spike','category')),
  event_key        text NOT NULL,
  title            text NOT NULL,
  body             text NOT NULL,
  session_date     date,
  announcement_seq_id text REFERENCES announcements(seq_id) ON DELETE SET NULL,
  read_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, symbol, kind, event_key)
);
CREATE INDEX alerts_created_idx ON alerts (created_at DESC);

CREATE TABLE push_subscriptions (
  endpoint    text PRIMARY KEY,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_ok_at  timestamptz
);

CREATE TABLE notification_deliveries (
  alert_id    uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  endpoint    text NOT NULL REFERENCES push_subscriptions(endpoint) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','gone')),
  attempts    int NOT NULL DEFAULT 0,
  last_error  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (alert_id, endpoint)
);

CREATE TABLE user_prefs (
  id                int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  category_weights  jsonb NOT NULL DEFAULT '{}',
  default_window    text NOT NULL DEFAULT '24h',
  updated_at        timestamptz NOT NULL DEFAULT now()
);
INSERT INTO user_prefs (id) VALUES (1);

CREATE TABLE interactions (
  id          bigserial PRIMARY KEY,
  seq_id      text REFERENCES announcements(seq_id) ON DELETE CASCADE,
  action      text NOT NULL CHECK (action IN ('pin','dismiss','open','undo')),
  category    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE llm_calls (
  id                 bigserial PRIMARY KEY,
  provider           text NOT NULL,
  model              text NOT NULL,
  purpose            text NOT NULL,
  prompt_tokens      int,
  completion_tokens  int,
  neurons            real,
  cache_hit          boolean NOT NULL DEFAULT false,
  schema_valid       boolean,
  latency_ms         int,
  error              text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX llm_calls_created_idx ON llm_calls (created_at DESC);

CREATE TABLE llm_cache (
  cache_key    text PRIMARY KEY,
  model        text NOT NULL,
  purpose      text NOT NULL,
  response     jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_hit_at  timestamptz,
  hit_count    int NOT NULL DEFAULT 0
);

-- ---------- Security: only server-side roles touch the database ----------
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated';
  END IF;
END $$;
