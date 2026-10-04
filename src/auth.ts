import type { Env, OAuthGrantInfo, TokenRow } from "./types";
import { normalizeToken, now, sha256, timeSafeEqual } from "./util";

export type Credential =
  | { kind: "master" }
  | { kind: "token"; token: TokenRow; oauth?: OAuthGrantInfo };

const TOKEN_COLUMNS = `id, email, label, token_hash, status, quota_monthly, requests_used,
                       requests_reset_at, rate_limit_per_min, rate_window, rate_count,
                       last_used_at, created_at, updated_at,
                       credits_granted, credits_used, credits_extra, jev_tokens_lifetime`;

/** The same projection, qualified with `t.` for the OAuth lookup's join. */
const TOKEN_COLUMNS_T = TOKEN_COLUMNS.split(",")
  .map((c) => `t.${c.trim()}`)
  .join(", ");

/**
 * Pull a bearer token from wherever the client put it.
 *
 * `Authorization: Bearer` is the MCP-canonical form, and is what an OAuth access
 * token arrives as. `x-api-key` is accepted because a number of MCP hosts
 * configure credentials that way, and `?token=` is accepted only so a token can
 * be pasted into a browser or curl one-liner -- MCP clients never need it.
 */
export function extractToken(request: Request): string | null {
  const auth = request.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7);
  const apiKey = request.headers.get("x-api-key");
  if (apiKey) return apiKey;
  const q = new URL(request.url).searchParams.get("token");
  if (q) return q;
  return null;
}

/**
 * Single authority for credential resolution.
 *
 * Three accepted forms, checked in order of cost:
 *
 *   1. the master `MCP_TOKEN` secret       -> bypasses D1 entirely
 *   2. an OAuth access token hash          -> joins to its `tokens` row
 *   3. a SHA-256 hash of a gateway token   -> a row in `tokens`
 *
 * Returns null whenever nothing valid was presented. Callers must treat null as
 * a denial and never as a pass.
 *
 * Fails closed on a misconfiguration: with no MCP_TOKEN and no matching row,
 * nothing authenticates. Note that a *disabled* row resolves to null rather
 * than to a special marker, so revocation takes effect on the very next request
 * with no caching window to wait out.
 *
 * ## Why OAuth and gateway tokens are hashed differently
 *
 * Gateway tokens are `kdj_` + lowercase base32, which is case-insensitive by
 * construction, so `normalizeToken` may fold case without weakening entropy --
 * that is what lets them survive a case-normalising proxy.
 *
 * OAuth access tokens are base64url (RFC 6749), where case *is* significant.
 * Folding case would map distinct tokens onto one hash, so they are hashed
 * exactly as presented. Getting this backwards silently breaks half of all
 * legitimate OAuth sessions, so the two paths are kept visually distinct.
 */
export async function resolveCredential(env: Env, request: Request): Promise<Credential | null> {
  const presented = extractToken(request);
  if (!presented) return null;
  const presentedTrimmed = presented.trim();

  // Master token first: it must keep working even when D1 is unavailable,
  // otherwise an outage would lock the operator out of their own gateway.
  const master = env.MCP_TOKEN;
  if (master && timeSafeEqual(normalizeToken(presentedTrimmed), normalizeToken(master))) {
    return { kind: "master" };
  }

  // OAuth access token. Hash verbatim -- see the note above.
  const oauthHash = await sha256(presentedTrimmed);
  const grant = await env.DB.prepare(
    `SELECT ${TOKEN_COLUMNS_T}, o.client_id AS grant_client_id, o.expires_at AS grant_expires_at,
            c.client_name
       FROM oauth_access_tokens o
       JOIN tokens t ON t.id = o.token_id
       LEFT JOIN oauth_clients c ON c.client_id = o.client_id
      WHERE o.token_hash = ? AND o.revoked = 0 AND o.expires_at > ?`,
  )
    .bind(oauthHash, now())
    .first<TokenRow & { grant_client_id: string; grant_expires_at: number; client_name: string | null }>();

  if (grant) {
    // A grant can outlive the token it was derived from. The join already
    // excluded a missing row, but a *disabled* one still joins.
    if (grant.status !== "active") return null;
    return {
      kind: "token",
      token: grant,
      oauth: {
        clientId: grant.grant_client_id,
        clientName: grant.client_name || "MCP client",
        expiresAt: grant.grant_expires_at,
      },
    };
  }

  const hash = await sha256(normalizeToken(presentedTrimmed));
  const row = await env.DB.prepare(`SELECT ${TOKEN_COLUMNS} FROM tokens WHERE token_hash = ?`)
    .bind(hash)
    .first<TokenRow>();
  if (!row) return null;
  if (row.status !== "active") return null;

  return { kind: "token", token: row };
}

/**
 * Admin gate for /admin and /api/admin/*.
 *
 * Deliberately a bare passkey rather than a second identity system: this is a
 * 100-seat gateway with one operator, and a full account system here would add
 * surface without adding safety.
 *
 * Fails closed -- if ADMIN_PASSKEY is unset, nothing is ever admin. There is
 * no default and no fallback, because a documented default passkey on a token
 * issuer is equivalent to no gate at all.
 */
export function isAdmin(env: Env, presented: string): boolean {
  const passkey = env.ADMIN_PASSKEY;
  if (!passkey || !presented) return false;
  return timeSafeEqual(presented, passkey);
}