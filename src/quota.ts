import type { Env, TokenRow } from "./types";
import { envInt, now } from "./util";

export type GateDecision =
  | { allowed: true; token: TokenRow }
  | { allowed: false; status: number; code: string; error: string; retryAfter?: number };

/**
 * Decide whether a credential may spend one upstream JEV call, and consume that
 * allowance if so.
 *
 * Two independent limits, checked cheapest-first:
 *
 *   1. requests_used < quota_monthly   -- monthly spend allowance
 *   2. rate_count < rate_limit_per_min -- burst ceiling within one UTC minute
 *
 * Both are enforced by a *conditional* UPDATE rather than read-then-write.
 * That matters under concurrency: two simultaneous requests that both read
 * `requests_used = 999` of a 1000 quota would each decide to allow themselves
 * and overshoot. Putting the predicate in the WHERE clause makes the database
 * itself the arbiter, so the increment either happens for exactly one of them
 * or for neither.
 *
 * The monthly window resets lazily on first use after it elapses. A cron would
 * need to be kept alive and would still miss users whose window lapsed while
 * idle; here the reset happens exactly when it matters and costs one statement
 * that is a no-op for every request inside an active window.
 */
export async function gateRequest(env: Env, token: TokenRow): Promise<GateDecision> {
  const t = now();
  const periodMs = envInt(env, "QUOTA_PERIOD_DAYS", 30) * 86_400_000;

  // Roll the monthly window forward if it has elapsed.
  await env.DB.prepare(
    `UPDATE tokens
        SET requests_used = 0,
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
    // The conditional update failed for one of two reasons. Re-read to report
    // the accurate one rather than guessing.
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
      error: `monthly quota exhausted (${fresh.requests_used}/${fresh.quota_monthly}). Ask an administrator to raise it.`,
    };
  }

  return {
    allowed: true,
    token: {
      ...token,
      requests_used: spend.requests_used,
      quota_monthly: spend.quota_monthly,
      rate_count: rate.rate_count,
      rate_window: bucket,
      last_used_at: t,
    },
  };
}

export interface UsageSnapshot {
  email: string;
  label: string | null;
  status: string;
  quota_monthly: number;
  requests_used: number;
  remaining: number;
  period_ends_at: number | null;
  rate_limit_per_min: number;
  rate_used_this_minute: number;
  calls_this_period: number;
  total_calls: number;
  input_tokens: number | null;
  output_tokens: number | null;
  last_used_at: number | null;
}

/**
 * Current allowance plus lifetime token spend.
 *
 * `remaining` is derived rather than stored so it cannot drift out of sync with
 * `requests_used` after a window reset.
 */
export async function usageSnapshot(env: Env, token: TokenRow): Promise<UsageSnapshot> {
  const row = await env.DB.prepare(
    `SELECT
        (SELECT COUNT(*) FROM usage_events WHERE token_id = ?) AS calls_this_period,
        (SELECT COALESCE(SUM(input_tokens), 0)  FROM usage_events WHERE token_id = ?) AS input_tokens,
        (SELECT COALESCE(SUM(output_tokens), 0) FROM usage_events WHERE token_id = ?) AS output_tokens,
        (SELECT COUNT(*) FROM usage_events WHERE token_id = ?) AS total_calls
      FROM tokens WHERE id = ?`,
  )
    .bind(token.id, token.id, token.id, token.id, token.id)
    .first<{ calls_this_period: number; input_tokens: number; output_tokens: number; total_calls: number }>();

  const bucket = Math.floor(now() / 60_000);
  const rateUsed = token.rate_window === bucket ? token.rate_count : 0;

  return {
    email: token.email,
    label: token.label,
    status: token.status,
    quota_monthly: token.quota_monthly,
    requests_used: token.requests_used,
    remaining: Math.max(0, token.quota_monthly - token.requests_used),
    period_ends_at: token.requests_reset_at,
    rate_limit_per_min: token.rate_limit_per_min,
    rate_used_this_minute: rateUsed,
    calls_this_period: row?.calls_this_period ?? 0,
    total_calls: row?.total_calls ?? 0,
    input_tokens: row?.input_tokens ?? 0,
    output_tokens: row?.output_tokens ?? 0,
    last_used_at: token.last_used_at,
  };
}