-- KD JEV MCP -- initial schema
--
-- A token gateway, not a memory store: this database holds identity,
-- allowance and an audit trail. Every row here is about *who may call the
-- upstream JEV API and how often*, never about the content they evaluate.

-- ---------------------------------------------------------------- tokens
CREATE TABLE IF NOT EXISTS tokens (
  id                 TEXT PRIMARY KEY,

  -- Stored lower-cased so the unique index below does case-sensitive
  -- matching; SQLite's default collation would otherwise let one person
  -- hold two accounts as "A@b.com" and "a@b.com".
  email              TEXT NOT NULL,

  -- Operator-facing name for the holder, e.g. "Alice (contractor)".
  label              TEXT,

  -- SHA-256 of the bearer token, never the token itself. A leaked database
  -- dump therefore yields no usable credentials, and the admin dashboard
  -- cannot re-display a token after creation -- it is shown exactly once.
  token_hash         TEXT NOT NULL,

  -- 'active' | 'disabled'. Disabled rows keep their history for audit but
  -- fail the quota gate immediately.
  status             TEXT NOT NULL DEFAULT 'active',

  -- Monthly allowance. Reset lazily (see resetIfPeriodElapsed) rather than
  -- by cron, so there is no scheduled job to keep alive.
  quota_monthly      INTEGER NOT NULL DEFAULT 1000,
  requests_used      INTEGER NOT NULL DEFAULT 0,
  requests_reset_at  INTEGER,

  -- Fixed per-minute ceiling. Stored per token so one noisy client can be
  -- throttled without touching the other 99.
  rate_limit_per_min INTEGER NOT NULL DEFAULT 60,

  -- Sliding-window counters. rate_window is the current UTC minute bucket
  -- (floor(now/60000)); a mismatch means the window rolled and the counter
  -- restarts from zero.
  rate_window        INTEGER NOT NULL DEFAULT 0,
  rate_count         INTEGER NOT NULL DEFAULT 0,

  last_used_at       INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_email ON tokens(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_hash  ON tokens(token_hash);
-- The 100-user cap counts active rows on every issuance; this index keeps
-- that COUNT(*) off a full table scan.
CREATE INDEX IF NOT EXISTS idx_tokens_status ON tokens(status);

-- ------------------------------------------------------------ usage_events
-- One row per upstream JEV call. This is the record of real spend: JEV bills
-- on input/output tokens, so quota alone would not explain the bill.
CREATE TABLE IF NOT EXISTS usage_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id      TEXT NOT NULL,
  email         TEXT NOT NULL,
  tool          TEXT NOT NULL,
  outcome       TEXT NOT NULL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  latency_ms    INTEGER,
  error         TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_token_created ON usage_events(token_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_created       ON usage_events(created_at DESC);

-- ------------------------------------------------------------- audit_logs
-- Operator actions: token generation, revocation, quota edits, and failed
-- admin logins. Separate from usage_events because these rows describe
-- changes to *access*, which is the thing worth reconstructing later.
CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT,
  ip         TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor   ON audit_logs(actor, created_at DESC);