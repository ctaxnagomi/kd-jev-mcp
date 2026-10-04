import type { Env, TokenRow } from "./types";
import { availableMicro, creditBalance, loadCreditSettings, moneyFor, tokenHealth, type CreditSettings, type TokenHealth } from "./credits";
import { envInt, now } from "./util";

export type GateDecision =
  | { allowed: true; token: TokenRow; settings: CreditSettings }
  | { allowed: false; status: number; code: string; error: string; retryAfter?: number };

/**
 * Decide whether a credential may spend one upstream JEV call.
 *
 * The credit balance is checked here but **debited after the call**, because a
 * call's cost is only knowable once upstream reports its token usage. Two
 * consequences follow, and both are deliberate:
 *
 *  1. The gate is a *pre-flight* check, not an accounting step. It answers "is
 *     this seat allowed to start another call", not "does it have enough to pay
 *     for it". A seat with 0.3 credits left is allowed to start a call that may
 *     overshoot; the balance goes negative, which is truthful, and the *next*
 *     call is blocked. Stopping the current call mid-flight is impossible --
 *     the money is already being spent upstream.
 *
 *  2. An optional per-month request ceiling still applies, but only when set
 *     above zero. It is a blast-radius guard, not the spend control: the credit
 *     balance is the spend control, and the rate limiter is the instantaneous
 *     one. Three overlapping spend limits would just be confusing.
 *
 * The rate limit stays a *conditional* UPDATE -- see below. The credit check is a
 * plain read because there is nothing to atomically arbitrate: the cost is not
 * known yet, and the debit that follows is not conditional on the balance by
 * design.
 */
export async function gateRequest(env: Env, token: TokenRow): Promise<GateDecision> {
  const t = now();
  const periodMs = envInt(env, "QUOTA_PERIOD_DAYS", 30) * 86_400_000;

  // Roll the window forward if it has elapsed. Resets the recurring credit grant
  // and the request counter together, and leaves credits_extra alone -- a top-up
  // must survive the reset or operators will stop trusting the balance.
  await env.DB.prepare(
    `UPDATE tokens
        SET requests_used = 0,
            credits_used = 0,
            requests_reset_at = ?,
            updated_at = ?
      WHERE id = ?
        AND (requests_reset_at IS NULL OR requests_reset_at <= ?)`,
  )
    .bind(t + periodMs, t, token.id, t)
    .run();

  const bucket = Math.floor(t / 60_000);

  // Restart the burst window if the minute rolled over. No-op otherwise, which
  // is the common case.
  await env.DB.prepare(
    "UPDATE tokens SET rate_window = ?, rate_count = 0, updated_at = ? WHERE id = ? AND rate_window <> ?",
  )
    .bind(bucket, t, token.id, bucket)
    .run();

  const rate = await env.DB.prepare(
    `UPDATE tokens
        SET rate_count = rate_count + 1,
            updated_at = ?
      WHERE id = ?
        AND rate_window = ?
        AND rate_count < ?      -- the arbiter: only one caller can win the last slot
   RETURNING rate_count`,
  )
    .bind(t, token.id, bucket, token.rate_limit_per_min)
    .first<{ rate_count: number }>();

  if (!rate) {
    return {
      allowed: false,
      status: 429,
      code: "rate_limited",
      error: `rate limit exceeded (${token.rate_limit_per_min} requests/minute)`,
      retryAfter: 60,
    };
  }

  const settings = await loadCreditSettings(env);

  // Optional secondary ceiling. Zero or negative means "no request cap".
  if (token.quota_monthly > 0) {
    const spend = await env.DB.prepare(
      `UPDATE tokens
          SET requests_used = requests_used + 1,
              last_used_at = ?,
              updated_at = ?
        WHERE id = ?
          AND status = 'active'
          AND requests_used < quota_monthly
   RETURNING requests_used, quota_monthly`,
    )
      .bind(t, t, token.id)
      .first<{ requests_used: number; quota_monthly: number }>();

    if (!spend) {
      const fresh = await env.DB.prepare("SELECT status, quota_monthly, requests_used FROM tokens WHERE id = ?")
        .bind(token.id)
        .first<{ status: string; quota_monthly: number; requests_used: number }>();

      if (!fresh || fresh.status !== "active") {
        return { allowed: false, status: 401, code: "token_disabled", error: "token has been revoked" };
      }
      return {
        allowed: false,
        status: 429,
        code: "quota_exceeded",
        error: `monthly request cap reached (${fresh.requests_used}/${fresh.quota_monthly}). Ask an administrator to raise it.`,
      };
    }
    token = { ...token, requests_used: spend.requests_used, quota_monthly: spend.quota_monthly };
  } else {
    await env.DB.prepare("UPDATE tokens SET requests_used = requests_used + 1, last_used_at = ?, updated_at = ? WHERE id = ?")
      .bind(t, t, token.id)
      .run();
    token = { ...token, requests_used: token.requests_used + 1, last_used_at: t };
  }

  // Credit check last: it is the cheapest failure to explain and the one a user
  // is most likely to hit, so it gets the most accurate error message.
  const available = availableMicro(token);
  if (available <= 0) {
    const fresh = await env.DB.prepare(
      "SELECT status, credits_granted, credits_used, credits_extra FROM tokens WHERE id = ?",
    )
      .bind(token.id)
      .first<{ status: string; credits_granted: number; credits_used: number; credits_extra: number }>();

    if (!fresh || fresh.status !== "active") {
      return { allowed: false, status: 401, code: "token_disabled", error: "token has been revoked" };
    }
    const bal = creditBalance({ ...token, ...fresh, status: token.status });
    return {
      allowed: false,
      status: 429,
      code: "credit_exhausted",
      error:
        `KD Credit balance exhausted (${bal.used} of ${bal.granted + bal.extra} used). ` +
        `Ask an administrator to top it up.`,
    };
  }

  return {
    allowed: true,
    token: { ...token, rate_count: rate.rate_count, rate_window: bucket, last_used_at: t },
    settings,
  };
}

export interface UsageSnapshot {
  email: string;
  label: string | null;
  status: string;
  health: TokenHealth;
  callable: boolean;
  /**
   * KD Credit only. Deliberately carries no currency: the user-facing surface
   * never states a price or a conversion rate, so the admin can restate rates
   * without a client ever needing to know.
   */
  credits: ReturnType<typeof creditBalance>;
  /** Secondary request cap, and how much of it is used. 0 means no cap. */
  request_cap: number | null;
  calls_this_period: number;
  total_calls: number;
  period_ends_at: number | null;
  rate_limit_per_min: number;
  rate_used_this_minute: number;
  last_used_at: number | null;
}

/**
 * Current allowance plus lifetime activity.
 *
 * `available` inside `credits` is derived rather than stored so it cannot drift
 * out of sync with the component fields after a window reset or a top-up.
 */
export async function usageSnapshot(env: Env, token: TokenRow): Promise<UsageSnapshot> {
  const row = await env.DB.prepare(
    `SELECT
        (SELECT COUNT(*) FROM usage_events WHERE token_id = ?) AS calls_this_period,
        (SELECT COUNT(*) FROM usage_events WHERE token_id = ?) AS total_calls
      FROM tokens WHERE id = ?`,
  )
    .bind(token.id, token.id, token.id)
    .first<{ calls_this_period: number; total_calls: number }>();

  const bucket = Math.floor(now() / 60_000);
  const rateUsed = token.rate_window === bucket ? token.rate_count : 0;
  const settings = await loadCreditSettings(env);
  const health = tokenHealth(token, settings);

  return {
    email: token.email,
    label: token.label,
    status: token.status,
    health,
    callable: health === "active" || health === "degraded" || health === "idle",
    credits: creditBalance(token),
    request_cap: token.quota_monthly > 0 ? token.quota_monthly : null,
    calls_this_period: row?.calls_this_period ?? 0,
    total_calls: row?.total_calls ?? 0,
    period_ends_at: token.requests_reset_at,
    rate_limit_per_min: token.rate_limit_per_min,
    rate_used_this_minute: rateUsed,
    last_used_at: token.last_used_at,
  };
}

/**
 * Admin-facing money view of a seat.
 *
 * The only place MYR and USD exist. Kept in quota.ts rather than the dashboard
 * so the conversion lives next to the arithmetic that produced the credits it is
 * converting, and so there is exactly one function that can do it.
 */
export async function adminMoneyView(
  env: Env,
  token: Pick<TokenRow, "credits_granted" | "credits_used" | "credits_extra" | "jev_tokens_lifetime">,
): Promise<{
  granted_myr: number;
  granted_usd: number;
  used_myr: number;
  used_usd: number;
  available_myr: number;
  available_usd: number;
  jev_tokens_lifetime: number;
}> {
  const settings = await loadCreditSettings(env);
  const granted = moneyFor(settings, token.credits_granted + token.credits_extra);
  const used = moneyFor(settings, token.credits_used);
  const available = moneyFor(settings, availableMicro(token as TokenRow));
  return {
    granted_myr: granted.myr,
    granted_usd: granted.usd,
    used_myr: used.myr,
    used_usd: used.usd,
    available_myr: available.myr,
    available_usd: available.usd,
    jev_tokens_lifetime: token.jev_tokens_lifetime,
  };
}