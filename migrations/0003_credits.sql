-- KD JEV MCP -- KD Credit balance
--
-- The service is free to the user, but it is not free to operate: JEV bills on
-- input/output tokens, so "how much has this seat cost me" is a real question
-- with a real answer. This migration makes that answer the primary control.
--
-- The canonical unit is the KD Credit. It exists so that:
--
--   * the user-facing surface shows one unit, and never a price;
--   * the admin can express a seat's allowance the way they budget -- in money;
--   * the accounting reconciles against the upstream invoice.
--
-- Internally credits are stored as MICRO-credits (1 KD Credit = 1,000,000
-- micro-credits) rather than whole credits. A single call typically costs a
-- fraction of a credit, so rounding each debit to a whole credit would overstate
-- real spend by up to 100% on small calls and would stop reconciling against the
-- invoice. Micro-credit precision makes the rounding error ~1e-6 of a credit,
-- which is invisible at any realistic volume.
--
-- Conversion rates live in D1, not in wrangler vars, because exchange rates move
-- and an operator should not need a redeploy to restate them.

-- ----------------------------------------------------------- credit_settings
-- Singleton row (id = 1). All configuration for the credit system.
CREATE TABLE IF NOT EXISTS credit_settings (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),

  -- How many JEV input+output tokens one KD Credit buys. This is the knob that
  -- ties the credit economy to the real bill: if TypeSafe's per-token price
  -- changes, set the currency-per-credit rates below to match. Do not change
  -- this casually -- every existing balance is denominated in it.
  tokens_per_credit     INTEGER NOT NULL DEFAULT 2000,

  -- Display conversions, in micros (1 unit = 1,000,000 micros). Used ONLY by the
  -- admin dashboard. Never returned to a user-facing endpoint.
  --
  -- At the defaults: 1 credit = 2000 tokens, so 1M tokens = 500 credits
  -- = USD 0.50 = MYR 2.35. Treat these as placeholders to reconcile against
  -- your actual invoice rather than as facts about anyone's pricing.
  myr_micros_per_credit INTEGER NOT NULL DEFAULT 4700,
  usd_micros_per_credit INTEGER NOT NULL DEFAULT 1000,

  -- Below this fraction of the total allowance a seat is reported 'degraded'.
  -- Stored as a percentage rather than an absolute so it tracks whatever
  -- allowance the seat happens to have.
  degraded_pct          INTEGER NOT NULL DEFAULT 20,

  -- Recurring allowance handed to a newly generated token, in whole KD Credit.
  -- Lives here rather than in wrangler vars so an operator can change what
  -- "a new seat gets" from the dashboard without a redeploy. Overridden per
  -- token at creation time by whatever the generate form supplied.
  default_credits       INTEGER NOT NULL DEFAULT 500,

  updated_at            INTEGER NOT NULL
);

INSERT OR IGNORE INTO credit_settings (id, tokens_per_credit, myr_micros_per_credit, usd_micros_per_credit, degraded_pct, default_credits, updated_at)
VALUES (1, 2000, 4700, 1000, 20, 500, 0);

-- ------------------------------------------------------------ token balances
--
-- Two kinds of credit, deliberately separated:
--
--   credits_granted  the recurring monthly allowance. Resets lazily with the
--                    existing window, so there is still no cron to keep alive.
--   credits_extra    one-off top-ups. NEVER resets.
--
-- Keeping them apart means a top-up is not silently eaten by the next reset --
-- the failure mode that makes operators stop trusting the balance.
ALTER TABLE tokens ADD COLUMN credits_granted  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tokens ADD COLUMN credits_used     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tokens ADD COLUMN credits_extra    INTEGER NOT NULL DEFAULT 0;

-- Lifetime JEV input+output tokens. Admin-only, and the figure that has to
-- reconcile against the upstream invoice. Kept separately from credits_used so a
-- rate change does not retroactively rewrite history.
ALTER TABLE tokens ADD COLUMN jev_tokens_lifetime INTEGER NOT NULL DEFAULT 0;

-- Balance math runs on every metered call, so index the expression's inputs.
CREATE INDEX IF NOT EXISTS idx_tokens_credits ON tokens(status, credits_granted);

-- --------------------------------------------------------- per-call debiting
--
-- One row per *charge*, recorded after the upstream call reports its real usage.
-- Separate from usage_events because that table is the request log and this one
-- is the money log: an operator reconciling an invoice reads this, and an
-- operator debugging latency reads that.
CREATE TABLE IF NOT EXISTS credit_ledger (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id       TEXT NOT NULL,
  email          TEXT NOT NULL,

  -- Micro-credits actually charged for this call.
  credits_micro  INTEGER NOT NULL,

  -- What it was billed on. Kept alongside the charge so a rate change can be
  -- re-derived rather than guessed at.
  jev_tokens     INTEGER NOT NULL DEFAULT 0,
  tool           TEXT,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_token   ON credit_ledger(token_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_created ON credit_ledger(created_at DESC);