// KD Credit accounting.
//
// The service is free to its users, so the user-facing surface deals in one
// unit -- the KD Credit -- and never in a price. The admin dashboard converts
// that same credit figure into MYR and USD, because the operator's real question
// is "what has this seat cost me", and JEV's real billing unit is tokens.
//
// Everything here is integer arithmetic. Credits are held as MICRO-credits
// (1 credit = 1,000,000 micro) because a single call usually costs a fraction of
// a credit; rounding each debit to a whole credit would overstate real spend by
// up to 100% on small calls and would stop reconciling against the invoice.

import type { Env, TokenRow } from "./types";

export const MICRO_PER_CREDIT = 1_000_000;

/** Operational state of a seat, derived from its balance rather than stored. */
export type TokenHealth =
  | "active"
  | "degraded"
  | "exhausted"
  | "revoked"
  | "idle";

export interface CreditSettings {
  tokens_per_credit: number;
  myr_micros_per_credit: number;
  usd_micros_per_credit: number;
  degraded_pct: number;
  /** Recurring grant, in whole credits, for a newly generated token. */
  default_credits: number;
}

const FALLBACK: CreditSettings = {
  tokens_per_credit: 2000,
  myr_micros_per_credit: 4700,
  usd_micros_per_credit: 1000,
  degraded_pct: 20,
  default_credits: 500,
};

/**
 * Load the credit configuration singleton.
 *
 * Falls back to compiled-in defaults rather than throwing. A missing or
 * unreadable settings row must not take the gateway down -- an operator who has
 * just migrated should get *some* consistent economy, and the fallback values are
 * documented as placeholders rather than silently wrong.
 */
export async function loadCreditSettings(env: Env): Promise<CreditSettings> {
  const row = await env.DB.prepare(
    `SELECT tokens_per_credit, myr_micros_per_credit, usd_micros_per_credit, degraded_pct, default_credits
       FROM credit_settings WHERE id = 1`,
  )
    .bind()
    .first<Partial<CreditSettings>>()
    .catch(() => null);

  const pick = (v: unknown, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };

  if (!row) return FALLBACK;
  return {
    tokens_per_credit: pick(row.tokens_per_credit, FALLBACK.tokens_per_credit),
    myr_micros_per_credit: pick(row.myr_micros_per_credit, FALLBACK.myr_micros_per_credit),
    usd_micros_per_credit: pick(row.usd_micros_per_credit, FALLBACK.usd_micros_per_credit),
    degraded_pct: Math.min(100, pick(row.degraded_pct, FALLBACK.degraded_pct)),
    default_credits: pick(row.default_credits, FALLBACK.default_credits),
  };
}

/**
 * Micro-credits owed for a JEV call that consumed `jevTokens` tokens.
 *
 * Rounded UP, always. Rounding down would systematically undercharge, and the
 * shortfall would accumulate in the operator's favour without ever appearing as
 * an error -- the worst kind of accounting bug. Rounding up can only ever
 * overcharge a user by less than one micro-credit per call, which is invisible.
 */
export function microCreditsFor(settings: CreditSettings, jevTokens: number): number {
  if (!Number.isFinite(jevTokens) || jevTokens <= 0) return 0;
  const perTokenMicro = settings.tokens_per_credit > 0 ? MICRO_PER_CREDIT / settings.tokens_per_credit : 0;
  if (perTokenMicro <= 0) return 0;
  return Math.max(1, Math.ceil(jevTokens * perTokenMicro));
}

/** Total credit the seat may still spend, in micro-credits. May be negative. */
export function availableMicro(token: TokenRow): number {
  return token.credits_granted + token.credits_extra - token.credits_used;
}

export interface CreditBalance {
  /** Recurring monthly allowance, in whole credits (display value). */
  granted: number;
  /** Spent this window, in whole credits. */
  used: number;
  /** Non-resetting top-ups, in whole credits. */
  extra: number;
  /** What is left to spend. Negative means the last call overshot the balance. */
  available: number;
  unit: string;
}

export function creditBalance(token: TokenRow): CreditBalance {
  const c = (micro: number) => Math.round((micro / MICRO_PER_CREDIT) * 1000) / 1000;
  return {
    granted: c(token.credits_granted),
    used: c(token.credits_used),
    extra: c(token.credits_extra),
    available: c(availableMicro(token)),
    unit: "KD Credit",
  };
}

/**
 * Operational state of a seat.
 *
 * Ordered deliberately: revocation is checked before balance, because a revoked
 * token with credits remaining is still revoked, and reporting it as "active"
 * because it has money left would be actively misleading.
 *
 * `idle` separates "has allowance, never used" from "has allowance, used some".
 * Those need different operator responses -- an unused seat may be a broken
 * integration, and a used one is simply working.
 */
export function tokenHealth(token: TokenRow, settings: CreditSettings): TokenHealth {
  if (token.status !== "active") return "revoked";
  const available = availableMicro(token);
  if (available <= 0) return "exhausted";
  const total = token.credits_granted + token.credits_extra;
  if (total > 0 && available * 100 < total * settings.degraded_pct) return "degraded";
  if (token.last_used_at == null) return "idle";
  return "active";
}

/** Whether a seat in this state can still make a metered call. */
export function isCallable(health: TokenHealth): boolean {
  return health === "active" || health === "degraded" || health === "idle";
}

/** Admin-only money view. Never returned from a user-facing endpoint. */
export interface MoneyView {
  myr: number;
  usd: number;
}

export function moneyFor(settings: CreditSettings, microCredits: number): MoneyView {
  return {
    myr: Math.round(((microCredits * settings.myr_micros_per_credit) / MICRO_PER_CREDIT) * 10_000) / 10_000,
    usd: Math.round(((microCredits * settings.usd_micros_per_credit) / MICRO_PER_CREDIT) * 10_000) / 10_000,
  };
}

/**
 * Record what a completed call actually cost.
 *
 * Debits `credits_used` and adds to the lifetime JEV token total, then writes a
 * ledger row, in one batched transaction.
 *
 * Two properties are worth stating:
 *
 *  1. The balance is allowed to go NEGATIVE. The real cost was incurred, and an
 *     accounting system that refuses to record it just loses the number. The
 *     pre-flight gate blocks the *next* call, which is where the user actually
 *     needs to be stopped -- not here, after the money is already spent.
 *
 *  2. It is NOT conditional on remaining balance, unlike the request counter.
 *     A conditional debit would be wrong: by the time we know the cost, it has
 *     already been paid upstream. The gate is the only place that arbitrates.
 */
export async function debitCall(
  env: Env,
  token: TokenRow,
  settings: CreditSettings,
  inputTokens: number | null,
  outputTokens: number | null,
  tool: string,
): Promise<number> {
  const jevTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
  const micro = microCreditsFor(settings, jevTokens);
  const t = Date.now();

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE tokens
          SET credits_used = credits_used + ?,
              jev_tokens_lifetime = jev_tokens_lifetime + ?,
              updated_at = ?
        WHERE id = ?`,
    ).bind(micro, jevTokens, t, token.id),
    env.DB.prepare(
      `INSERT INTO credit_ledger (token_id, email, credits_micro, jev_tokens, tool, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(token.id, token.email, micro, jevTokens, tool, t),
  ]);

  return micro;
}

/**
 * Parse an admin-entered credit amount into micro-credits.
 *
 * ROUNDS rather than floors. `0.001 * 1_000_000` is `1000.0000000000001` in
 * binary floating point, so a floor here would silently turn an operator's
 * "0.001 KD Credit" into 1000 micro-credits one run and 999 the next depending
 * on how the decimal happened to land. Rounding to the nearest micro-credit is
 * the only defensible reading of an amount someone typed, and nobody types
 * sub-micro-credit precision deliberately.
 */
export function parseCredits(input: unknown): number | null {
  const n = Number(input);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * MICRO_PER_CREDIT);
}

/** Format micro-credits for the dashboard without exposing floating point noise. */
export function formatCredits(micro: number): string {
  return (micro / MICRO_PER_CREDIT).toFixed(3).replace(/\.?0+$/, "") || "0";
}