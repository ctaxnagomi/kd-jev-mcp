import type { Env } from "./types";

export function now(): number {
  return Date.now();
}

export function uuid(): string {
  return crypto.randomUUID();
}

/** Lower-case hex SHA-256. Used to store token *references*, never token values. */
export async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * Crockford-style base32 (lowercase, no padding).
 *
 * Base32 rather than hex or base64 because bearer tokens travel in headers,
 * query strings and config files that get copy-pasted, and because a token
 * must survive being uppercased by something in the middle (some proxies
 * normalise header case). A lowercase base32 alphabet is case-insensitive by
 * construction, so `normalizeToken` can fold case without weakening entropy.
 *
 * 30 bytes -> 48 characters. Entropy is far beyond the point of brute force;
 * the length is kept short enough to paste into a config file.
 */
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(30));
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return `kdj_${out}`;
}

/**
 * Fold a presented token into its canonical form before hashing.
 *
 * Trims whitespace and lower-cases, so a token that round-tripped through a
 * case-normalising proxy still resolves to the same row.
 */
export function normalizeToken(token: string): string {
  return token.trim().toLowerCase();
}

/**
 * Constant-time string comparison.
 *
 * Length is leaked (it must be, to index the strings) but every
 * position-dependent branch is eliminated, so a timing oracle cannot be used
 * to recover a passkey or master token one character at a time.
 */
export function timeSafeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers || {}) },
  });
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Parse an env var as a bounded positive integer, falling back when unset or junk. */
export function envInt(env: Env, key: keyof Env, fallback: number): number {
  const raw = env[key];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Same, but where zero is a MEANINGFUL value rather than "unset".
 *
 * `envInt` treats 0 as absent, which is right for a rate limit (0 requests/minute
 * is nonsense) and wrong for a request cap (0 = "no cap"). Using `envInt` there
 * meant DEFAULT_QUOTA_MONTHLY="0" silently fell back to 1000 and quietly
 * re-imposed the exact ceiling an operator had switched off -- the setting read
 * as configured in wrangler.jsonc and behaved otherwise, which is the worst kind
 * of config bug to debug.
 */
export function envIntAllowZero(env: Env, key: keyof Env, fallback: number): number {
  const raw = env[key];
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * Append-only operator audit row.
 *
 * Returns the prepared statement rather than running it so callers can batch
 * it with their own writes and await them together in a single ctx.waitUntil.
 */
export function auditRow(
  env: Env,
  actor: string,
  action: string,
  detail: string | null,
  request: Request,
): D1PreparedStatement {
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "";
  const agent = (request.headers.get("user-agent") || "").slice(0, 200);
  return env.DB.prepare(
    "INSERT INTO audit_logs (actor, action, detail, ip, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(actor, action, detail, ip, agent, now());
}

export function randomIdempotencyKey(): string {
  return uuid();
}