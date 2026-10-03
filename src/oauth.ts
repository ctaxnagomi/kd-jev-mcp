// OAuth 2.1 authorization server, hosted in the Worker itself.
//
// The Worker is both the authorization server and the resource server -- there
// is no external IdP. MCP hosts (Claude Code, ChatGPT, Cursor, and anything
// else that speaks the MCP OAuth profile) discover the endpoints from the two
// well-known documents, register dynamically via DCR, and run an
// authorization-code flow with PKCE S256.
//
// ## Why identity is a gateway token rather than a passkey
//
// The reference project (dgui-hypermem) authorizes OAuth against an email +
// passkey pair. Here the holder signs in with the `kdj_...` token they were
// already issued, and the grant is bound to that row's `tokens.id`:
//
//   * nothing new to lose or distribute -- the credential already exists;
//   * revoking a token in the admin dashboard kills every OAuth session derived
//     from it on the next request, with no cache to wait out;
//   * quota and attribution resolve identically whether the caller used a
//     pasted bearer token or an OAuth access token, because both funnel into
//     the same `tokens` row before the gate runs.
//
// ## Scope of surface
//
// Only `/mcp` is an OAuth-protected resource. The REST routes keep bearer
// tokens, because they are called from curl and scripts where a browser
// consent flow is pure friction.

import type { Env, TokenRow } from "./types";
import { json, now, sha256, timeSafeEqual, uuid } from "./util";
import { normalizeToken } from "./util";

const ACCESS_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SCOPES = ["mcp"];
const DEFAULT_SCOPE = "mcp";

/* ---------------------------------------------------------------- helpers */

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Opaque high-entropy string for OAuth credentials.
 *
 * Deliberately not `randomToken` from util: OAuth tokens are base64url per
 * RFC 6749 and must not carry the `kdj_` prefix, which belongs to gateway
 * tokens and is what `resolveCredential` routes on.
 */
function randomSecret(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function pkceS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

function parseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function isLoopback(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "localhost";
}

/** Accept both `application/x-www-form-urlencoded` and `application/json`. */
async function readForm(request: Request): Promise<URLSearchParams> {
  const type = (request.headers.get("content-type") || "").toLowerCase();
  if (type.includes("application/json")) {
    try {
      const body = (await request.json()) as Record<string, unknown>;
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(body ?? {})) {
        if (typeof v === "string") params.set(k, v);
        else if (v !== undefined && v !== null) params.set(k, JSON.stringify(v));
      }
      return params;
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(await request.text());
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, { status, headers: { "cache-control": "no-store" } });
}

/* ------------------------------------------------------------------- DCR */

/**
 * Dynamic Client Registration (RFC 7591).
 *
 * MCP hosts register themselves at connect time rather than being pre-enrolled,
 * which is what makes "add a connector" a one-click operation for the user.
 */
export async function handleRegister(env: Env, request: Request): Promise<Response> {
  if (request.method !== "POST") return oauthError("invalid_request", "registration requires POST", 405);

  const body = (await readForm(request)) as unknown as Record<string, any>;
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];

  if (redirectUris.length === 0) {
    return oauthError("invalid_redirect_uri", "at least one redirect_uri is required");
  }
  for (const uri of redirectUris) {
    if (typeof uri !== "string") return oauthError("invalid_redirect_uri", "redirect_uris must be strings");
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      return oauthError("invalid_redirect_uri", `malformed redirect_uri: ${uri}`);
    }
    // Plain http is only tolerable for native loopback clients; anything else
    // would put the authorization code on the wire in cleartext.
    if (parsed.protocol === "http:" && !isLoopback(parsed)) {
      return oauthError("invalid_redirect_uri", "http redirect_uri is only allowed for loopback addresses");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return oauthError("invalid_redirect_uri", `unsupported redirect_uri scheme: ${parsed.protocol}`);
    }
  }

  const grantTypes: string[] = Array.isArray(body.grant_types)
    ? body.grant_types.filter((x: unknown): x is string => typeof x === "string")
    : ["authorization_code", "refresh_token"];
  for (const g of grantTypes) {
    if (g !== "authorization_code" && g !== "refresh_token") {
      return oauthError("invalid_client_metadata", `unsupported grant_type: ${g}`);
    }
  }

  const authMethod =
    typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "none";
  if (!["none", "client_secret_post", "client_secret_basic"].includes(authMethod)) {
    return oauthError(
      "invalid_client_metadata",
      `unsupported token_endpoint_auth_method: ${authMethod}`,
    );
  }

  const clientId = `kdjo_${randomSecret(18)}`;
  const clientSecret = authMethod === "none" ? null : randomSecret(32);
  const clientName = typeof body.client_name === "string" ? body.client_name.slice(0, 120) : "MCP client";
  const scope = typeof body.scope === "string" ? body.scope : DEFAULT_SCOPE;

  await env.DB.prepare(
    `INSERT INTO oauth_clients
       (client_id, client_secret_hash, client_name, redirect_uris, grant_types, response_types,
        token_endpoint_auth_method, scope, created_at)
     VALUES (?, ?, ?, ?, ?, '["code"]', ?, ?, ?)`,
  )
    .bind(
      clientId,
      clientSecret ? await sha256(clientSecret) : null,
      clientName,
      JSON.stringify(redirectUris),
      JSON.stringify(grantTypes),
      authMethod,
      scope,
      now(),
    )
    .run();

  return json(
    {
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      client_id_issued_at: Math.floor(now() / 1000),
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: ["code"],
      token_endpoint_auth_method: authMethod,
      scope,
    },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}

/* ---------------------------------------------------------- authorization */

interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  state: string | null;
  scope: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string | null;
  error: string | null;
  errorDescription: string | null;
}

/**
 * Every OAuth parameter the consent form must round-trip back on POST, as
 * [AuthorizeParams key, wire parameter name]. `error` and `errorDescription` are
 * deliberately absent: they only ever arrive from an inbound redirect and must
 * never be echoed back into a form we then act on.
 */
const CONSENT_FIELDS: ReadonlyArray<[keyof AuthorizeParams, string]> = [
  ["clientId", "client_id"],
  ["redirectUri", "redirect_uri"],
  ["state", "state"],
  ["scope", "scope"],
  ["codeChallenge", "code_challenge"],
  ["codeChallengeMethod", "code_challenge_method"],
  ["resource", "resource"],
];

function readAuthorizeParams(q: URLSearchParams): AuthorizeParams {
  return {
    clientId: q.get("client_id") || "",
    redirectUri: q.get("redirect_uri") || "",
    state: q.get("state"),
    scope: q.get("scope") || DEFAULT_SCOPE,
    codeChallenge: q.get("code_challenge") || "",
    codeChallengeMethod: q.get("code_challenge_method") || "",
    resource: q.get("resource"),
    error: q.get("error"),
    errorDescription: q.get("error_description"),
  };
}

function redirectWithError(p: AuthorizeParams, error: string, description: string): string {
  const target = new URL(p.redirectUri);
  target.searchParams.set("error", error);
  target.searchParams.set("error_description", description);
  if (p.state) target.searchParams.set("state", p.state);
  return target.toString();
}

/**
 * Errors that must NOT be redirected (RFC 6749 4.1.2.1), because the client or
 * redirect target is unvalidated. Everything else bounces back to the client so
 * the user agent lands somewhere sensible.
 */
function rejectAuthorize(p: AuthorizeParams, error: string, description: string): Response {
  if (!p.clientId || !p.redirectUri) return oauthError(error, description);
  return new Response(null, {
    status: 302,
    headers: { location: redirectWithError(p, error, description), "cache-control": "no-store" },
  });
}

async function loadClient(env: Env, clientId: string) {
  return env.DB.prepare("SELECT * FROM oauth_clients WHERE client_id = ?")
    .bind(clientId)
    .first<{
      client_id: string;
      client_secret_hash: string | null;
      client_name: string;
      redirect_uris: string;
      token_endpoint_auth_method: string;
    }>();
}

/**
 * Resolve the person attempting the grant.
 *
 * Both halves must match a single row: the email alone is not proof of
 * identity, and the token alone would let anyone who stole it authorize as
 * whoever it belongs to without knowing the address. Requiring both means a
 * stolen token still cannot be spent silently.
 */
export async function resolveOAuthIdentity(
  env: Env,
  email: string,
  presentedToken: string,
): Promise<{ ok: true; token: TokenRow } | { ok: false; error: string }> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail || !presentedToken) {
    return { ok: false, error: "Email and API token are both required." };
  }

  const hash = await sha256(normalizeToken(presentedToken));
  const row = await env.DB.prepare(
    `SELECT id, email, label, token_hash, status, quota_monthly, requests_used, requests_reset_at,
            rate_limit_per_min, rate_window, rate_count, last_used_at, created_at, updated_at
       FROM tokens WHERE email = ? AND token_hash = ?`,
  )
    .bind(normalizedEmail, hash)
    .first<TokenRow>();

  if (!row) return { ok: false, error: "That email and API token do not match any active token." };
  if (row.status !== "active") {
    return { ok: false, error: "That token has been revoked. Ask an administrator to restore it." };
  }
  return { ok: true, token: row };
}

function consentPage(
  p: AuthorizeParams,
  clientName: string,
  message: string,
  kind: "error" | "info",
): string {
  const color = kind === "error" ? "#f87171" : "#4ade80";
  // The form must carry the OAuth parameters back under their wire names while
  // AuthorizeParams holds them in camelCase. The two lists are written out
  // explicitly rather than derived from one another: an earlier version iterated
  // the wire names and read them off the camelCase object, which silently
  // emitted nothing for every name that differed and so dropped client_id,
  // redirect_uri, code_challenge and code_challenge_method. Typing the keys as
  // keyof AuthorizeParams makes that a compile error instead.
  const hidden = CONSENT_FIELDS.map(([prop, wire]) => {
    const v = p[prop];
    return v ? `<input type="hidden" name="${wire}" value="${escapeHtml(v)}">` : "";
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Authorize — KD JEV MCP</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box;margin:0;padding:0}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0a;
       color:#fff;font-family:ui-sans-serif,-apple-system,'Segoe UI',Roboto,sans-serif;padding:20px}
  .card{width:100%;max-width:430px;background:#16181c;border:1px solid #262a30;border-radius:14px;padding:30px}
  h1{font-size:20px;font-weight:600;letter-spacing:-.02em;margin-bottom:6px}
  .sub{font-size:13px;color:#7d8187;line-height:1.6;margin-bottom:22px}
  .client{background:#0a0a0a;border:1px solid #262a30;border-radius:8px;padding:12px 14px;font-size:13px;
          margin-bottom:20px;word-break:break-word}
  .client b{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#7d8187;margin-bottom:4px}
  label{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:#7d8187;margin:0 0 6px}
  input{width:100%;padding:11px 13px;margin-bottom:16px;background:#0a0a0a;border:1px solid #262a30;
        border-radius:8px;color:#fff;font-size:14px;font-family:inherit;outline:none}
  input:focus{border-color:#00f0ff}
  input.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
  button{width:100%;padding:12px;border:0;border-radius:8px;background:#00f0ff;color:#000;font-size:14px;
         font-weight:600;cursor:pointer;font-family:inherit}
  button:hover{opacity:.88}
  .msg{padding:11px 13px;border-radius:8px;font-size:13px;margin-bottom:20px;border:1px solid ${color}55;background:${color}14;color:${color}}
  .foot{margin-top:20px;font-size:11px;color:#5c6067;text-align:center;line-height:1.7}
  .foot a{color:#7d8187}
</style>
</head>
<body>
  <main class="card">
    <h1>Authorize access</h1>
    <p class="sub">Sign in with your KD JEV MCP API token to let <b>${escapeHtml(clientName)}</b> use your JEV quota.</p>
    ${message ? `<div class="msg">${escapeHtml(message)}</div>` : ""}
    <div class="client"><b>Requested permission</b>Call the JEV reasoning primitives (choice, noul, score) on your behalf, and spend your monthly quota doing so.</div>
    <form method="POST" action="/authorize" autocomplete="off">
      ${hidden}
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required autocomplete="username" placeholder="you@example.com">
      <label for="token">API token</label>
      <input type="password" id="token" name="token" required autocomplete="current-password" class="mono" placeholder="kdj_…">
      <button type="submit">Authorize</button>
    </form>
    <p class="foot">KrackedDevs &middot; <a href="/">KD JEV MCP</a><br>
      Revoke a connected app any time from your administrator's token table.</p>
  </main>
</body>
</html>`;
}

export async function handleAuthorize(env: Env, request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return oauthError("invalid_request", "use GET or POST", 405);
  }
  // On POST the OAuth parameters came back through the consent form, so they
  // live in the request body rather than the query string.
  const params = request.method === "POST" ? await readForm(request) : new URL(request.url).searchParams;
  const p = readAuthorizeParams(params);

  // The client already reported an error; bounce it straight back.
  if (p.error) {
    return new Response(null, {
      status: 302,
      headers: { location: redirectWithError(p, p.error, p.errorDescription || ""), "cache-control": "no-store" },
    });
  }

  if (!p.clientId) return oauthError("invalid_request", "client_id is required");
  if (!p.redirectUri) return oauthError("invalid_request", "redirect_uri is required");
  if (p.codeChallengeMethod !== "S256") {
    return rejectAuthorize(p, "invalid_request", "code_challenge_method must be S256");
  }
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(p.codeChallenge)) {
    return rejectAuthorize(p, "invalid_request", "a PKCE code_challenge is required");
  }

  const client = await loadClient(env, p.clientId);
  if (!client) return oauthError("invalid_client", "unknown client_id");
  if (!parseJsonArray(client.redirect_uris).includes(p.redirectUri)) {
    return oauthError("invalid_request", "redirect_uri does not match the registered value");
  }

  if (request.method === "GET") {
    return new Response(consentPage(p, client.client_name, "", "info"), {
      headers: { "content-type": "text/html;charset=UTF-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
    });
  }

  const identity = await resolveOAuthIdentity(
    env,
    params.get("email") || "",
    params.get("token") || "",
  );
  if (!identity.ok) {
    return new Response(consentPage(p, client.client_name, identity.error, "error"), {
      status: 401,
      headers: { "content-type": "text/html;charset=UTF-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
    });
  }

  const code = randomSecret(32);
  await env.DB.prepare(
    `INSERT INTO oauth_codes
       (code_hash, client_id, token_id, email, redirect_uri, scope, code_challenge, code_challenge_method,
        resource, expires_at, used, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'S256', ?, ?, 0, ?)`,
  )
    .bind(
      await sha256(code),
      p.clientId,
      identity.token.id,
      identity.token.email,
      p.redirectUri,
      p.scope,
      p.codeChallenge,
      p.resource,
      now() + CODE_TTL_MS,
      now(),
    )
    .run();

  const target = new URL(p.redirectUri);
  target.searchParams.set("code", code);
  if (p.state) target.searchParams.set("state", p.state);
  return new Response(null, {
    status: 302,
    headers: { location: target.toString(), "cache-control": "no-store" },
  });
}

/* ------------------------------------------------------------ token grant */

async function issueTokens(
  env: Env,
  args: { clientId: string; tokenId: string; email: string; scope: string; resource: string | null },
): Promise<Record<string, unknown>> {
  const accessToken = randomSecret(32);
  const refreshToken = randomSecret(32);
  await env.DB.prepare(
    `INSERT INTO oauth_access_tokens
       (id, token_hash, client_id, token_id, email, scope, refresh_token_hash, resource, expires_at, revoked, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  )
    .bind(
      uuid(),
      await sha256(accessToken),
      args.clientId,
      args.tokenId,
      args.email,
      args.scope,
      await sha256(refreshToken),
      args.resource,
      now() + ACCESS_TTL_MS,
      now(),
    )
    .run();

  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
    refresh_token: refreshToken,
    scope: args.scope,
    // Echoed back when the client sent `resource`. MCP clients use this to
    // confirm the grant was bound to the resource they asked for.
    ...(args.resource ? { resource: args.resource } : {}),
  };
}

async function authenticateClient(env: Env, request: Request, form: URLSearchParams) {
  let clientId = form.get("client_id") || "";
  let clientSecret = form.get("client_secret") || "";

  const basic = request.headers.get("authorization") || "";
  if (basic.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = atob(basic.slice(6).trim());
      const idx = decoded.indexOf(":");
      if (idx > 0) {
        clientId = decodeURIComponent(decoded.slice(0, idx));
        clientSecret = decodeURIComponent(decoded.slice(idx + 1));
      }
    } catch {
      /* fall through to form values */
    }
  }
  if (!clientId) return null;
  const client = await loadClient(env, clientId);
  if (!client) return null;
  if (client.client_secret_hash) {
    if (!clientSecret) return null;
    if (!timeSafeEqual(await sha256(clientSecret), client.client_secret_hash)) return null;
  }
  return client;
}

export async function handleToken(env: Env, request: Request): Promise<Response> {
  if (request.method !== "POST") return oauthError("invalid_request", "token requires POST", 405);
  const form = await readForm(request);
  const grantType = form.get("grant_type") || "";

  const client = await authenticateClient(env, request, form);
  if (!client) return oauthError("invalid_client", "client authentication failed", 401);

  if (grantType === "authorization_code") {
    const code = form.get("code") || "";
    const redirectUri = form.get("redirect_uri") || "";
    const verifier = form.get("code_verifier") || "";
    if (!code) return oauthError("invalid_request", "code is required");
    if (!verifier) return oauthError("invalid_request", "code_verifier is required");

    const row = await env.DB.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?")
      .bind(await sha256(code))
      .first<{
        code_hash: string;
        client_id: string;
        token_id: string;
        email: string;
        redirect_uri: string;
        scope: string;
        code_challenge: string;
        code_challenge_method: string;
        resource: string | null;
        expires_at: number;
        used: number;
      }>();
    if (!row) return oauthError("invalid_grant", "unknown authorization code");
    if (row.used) return oauthError("invalid_grant", "authorization code already used");
    if (row.expires_at <= now()) return oauthError("invalid_grant", "authorization code expired");
    if (row.client_id !== client.client_id) {
      return oauthError("invalid_grant", "code was issued to a different client");
    }
    if (redirectUri !== row.redirect_uri) return oauthError("invalid_grant", "redirect_uri mismatch");
    if (row.code_challenge_method !== "S256") {
      return oauthError("invalid_grant", "unsupported code_challenge_method");
    }
    if (!timeSafeEqual(await pkceS256(verifier), row.code_challenge)) {
      return oauthError("invalid_grant", "PKCE verification failed");
    }

    // Burn the code before minting tokens so a replay cannot race the first use.
    // The conditional UPDATE is the lock: two concurrent exchanges of the same
    // code both read used=0, but only one can flip it, and only that one sees a
    // non-zero change count.
    const burned = await env.DB.prepare("UPDATE oauth_codes SET used = 1 WHERE code_hash = ? AND used = 0")
      .bind(row.code_hash)
      .run();
    if (Number(burned?.meta?.changes ?? 0) !== 1) {
      return oauthError("invalid_grant", "authorization code already used");
    }

    // Re-check the account at exchange time, not just at authorize time. A token
    // revoked in the gap between the two must not yield a working session.
    const account = await env.DB.prepare("SELECT status FROM tokens WHERE id = ?")
      .bind(row.token_id)
      .first<{ status: string }>();
    if (!account || account.status !== "active") {
      return oauthError("invalid_grant", "the authorizing token is no longer active");
    }

    return json(
      await issueTokens(env, {
        clientId: client.client_id,
        tokenId: row.token_id,
        email: row.email,
        scope: row.scope,
        resource: row.resource,
      }),
      { headers: { "cache-control": "no-store" } },
    );
  }

  if (grantType === "refresh_token") {
    const presented = form.get("refresh_token") || "";
    if (!presented) return oauthError("invalid_request", "refresh_token is required");
    const presentedHash = await sha256(presented);

    const row = await env.DB.prepare(
      `SELECT id, token_hash, client_id, token_id, email, scope, resource, refresh_token_hash, expires_at, revoked
         FROM oauth_access_tokens WHERE refresh_token_hash = ?`,
    )
      .bind(presentedHash)
      .first<{
        id: string;
        token_hash: string;
        client_id: string;
        token_id: string;
        email: string;
        scope: string;
        resource: string | null;
        refresh_token_hash: string;
        expires_at: number;
        revoked: number;
      }>();
    if (!row || row.revoked) return oauthError("invalid_grant", "unknown refresh token");
    if (row.expires_at <= now()) return oauthError("invalid_grant", "refresh token expired");
    if (row.client_id !== client.client_id) {
      return oauthError("invalid_grant", "refresh token belongs to a different client");
    }

    const account = await env.DB.prepare("SELECT status FROM tokens WHERE id = ?")
      .bind(row.token_id)
      .first<{ status: string }>();
    if (!account || account.status !== "active") {
      return oauthError("invalid_grant", "the authorizing token is no longer active");
    }

    // Rotate: the presented refresh token is revoked as the new pair is issued.
    await env.DB.prepare("UPDATE oauth_access_tokens SET revoked = 1 WHERE token_hash = ?")
      .bind(row.token_hash)
      .run();

    const tokens = await issueTokens(env, {
      clientId: row.client_id,
      tokenId: row.token_id,
      email: row.email,
      scope: row.scope,
      resource: row.resource,
    });
    // Preserve the original absolute lifetime rather than sliding forever, so a
    // refresh loop cannot keep a grant alive past its intended window.
    const remaining = Math.max(0, Math.floor((row.expires_at - now()) / 1000));
    return json({ ...tokens, expires_in: remaining }, { headers: { "cache-control": "no-store" } });
  }

  return oauthError("unsupported_grant_type", `unsupported grant_type: ${grantType}`);
}

/* -------------------------------------------------------------- revocation */

export async function handleRevoke(env: Env, request: Request): Promise<Response> {
  if (request.method !== "POST") return oauthError("invalid_request", "revocation requires POST", 405);
  const form = await readForm(request);
  const client = await authenticateClient(env, request, form);
  if (!client) return oauthError("invalid_client", "client authentication failed", 401);

  const presented = form.get("token") || "";
  if (!presented) return oauthError("invalid_request", "token is required");
  const hash = await sha256(presented);

  // RFC 7009: always 200, whether or not the token existed. Scoped to the
  // authenticating client so one client cannot revoke another's grant.
  await env.DB.prepare(
    "UPDATE oauth_access_tokens SET revoked = 1 WHERE client_id = ? AND (token_hash = ? OR refresh_token_hash = ?)",
  )
    .bind(client.client_id, hash, hash)
    .run();
  return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
}

/**
 * Revoke every OAuth session derived from a gateway token.
 *
 * Called when a token is revoked, disabled, or rotated in the admin dashboard.
 * Without this, revoking a compromised token would leave live OAuth access
 * tokens outstanding for up to an hour -- long enough to be the whole incident.
 */
export async function revokeSessionsForToken(env: Env, tokenId: string): Promise<void> {
  await env.DB.prepare("UPDATE oauth_access_tokens SET revoked = 1 WHERE token_id = ? AND revoked = 0")
    .bind(tokenId)
    .run()
    .catch(() => undefined);
  await env.DB.prepare("UPDATE oauth_codes SET used = 1 WHERE token_id = ? AND used = 0")
    .bind(tokenId)
    .run()
    .catch(() => undefined);
}

/* ---------------------------------------------------------- discovery docs */

/**
 * Resource metadata (RFC 9728) -- tells an MCP client which authorization
 * server protects this resource.
 *
 * Served from both the root and path-suffixed locations because clients differ:
 * Claude Code probes the root, others probe with the resource path appended.
 */
export function handleProtectedResource(request: Request): Response {
  const origin = new URL(request.url).origin;
  return json(
    {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: SCOPES,
      bearer_methods_supported: ["header"],
      resource_name: "KD JEV MCP",
      resource_documentation: `${origin}/`,
      vendor: "KrackedDevs",
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}

/** Authorization server metadata (RFC 8414). */
export function handleAuthorizationServer(request: Request): Response {
  const origin = new URL(request.url).origin;
  return json(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      revocation_endpoint: `${origin}/revoke`,
      scopes_supported: SCOPES,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      // RFC 7591 dynamic registration. Saying so explicitly saves some clients a
      // probe request before they discover it anyway.
      service_documentation: `${origin}/`,
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}

/**
 * The 401 challenge that starts an MCP OAuth handshake.
 *
 * `resource_metadata` is the load-bearing part: it is how a client that has only
 * been given the `/mcp` URL finds the authorization server without being
 * configured with one.
 */
export function unauthorizedChallenge(request: Request): Response {
  const origin = new URL(request.url).origin;
  return json(
    {
      error: "unauthorized",
      hint: "Authorize this client via OAuth, or send Authorization: Bearer kdj_...",
      resource_metadata: `${origin}/.well-known/oauth-protected-resource`,
    },
    {
      status: 401,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "www-authenticate": `Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
        "cache-control": "no-store",
      },
    },
  );
}

/** Where an MCP client sends someone who has no token yet. */
export function connectUrl(request: Request): string {
  const origin = new URL(request.url).origin;
  return `${origin}/admin`;
}