// End-to-end OAuth 2.1 flow test against a running `wrangler dev`.
//
// Usage: node scripts/oauth.mjs
//
// The smoke suite covers the gateway data plane (tokens, credits, JEV primitives).
// This suite covers the authorization plane that MCP hosts actually walk:
// discovery -> DCR -> consent -> PKCE exchange -> MCP call -> refresh -> revoke.
//
// What is asserted here and nowhere else:
//   * the RFC 9728 / RFC 8414 documents a client bootstraps from
//   * the 401 challenge that points a client at those documents
//   * dynamic client registration and its redirect_uri rules
//   * that the identity check is email AND token, not either alone
//   * PKCE S256 is enforced (a wrong verifier must not mint tokens)
//   * an authorization code is single-use
//   * an OAuth access token really works against /mcp and is charged against its
//     holder's credit balance (the OAuth grant is an identity, never a second bill)
//   * refresh rotates and invalidates the presented refresh token
//   * revoking a gateway token kills every OAuth session derived from it
//
// Not part of the deployed bundle -- dev tooling only.

import { createHash, randomBytes } from "node:crypto";

const BASE = process.env.KD_BASE || "http://127.0.0.1:8787";
const PK = process.env.ADMIN_PASSKEY;

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? " :: " + detail : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/* --------------------------------------------------------------- helpers */

async function get(path, init = {}) {
  const res = await fetch(BASE + path, { redirect: "manual", ...init });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, json, text };
}

async function postForm(path, params, init = {}) {
  return get(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(init.headers || {}) },
    body: new URLSearchParams(params).toString(),
    ...init,
  });
}

async function admin(body) {
  return get("/api/admin/tokens", {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-passkey": PK || "" },
    body: JSON.stringify(body),
  });
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function makePkce() {
  const verifier = b64url(randomBytes(48)); // 64 chars, inside the 43..128 window
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function mcpCall(token, payload) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, json, text };
}

/** Pull the `code`/`state` out of a 302 Location without following it. */
function codeFromRedirect(res) {
  const loc = res.headers.get("location");
  if (!loc) return null;
  try {
    return new URL(loc);
  } catch {
    return null;
  }
}

const EMAIL = `oauth-${Date.now()}@example.com`;
const REDIRECT = "http://127.0.0.1:55999/callback";

/**
 * Addresses created by EITHER suite. Matching both keeps the two runnable in
 * either order, repeatedly.
 *
 * MAX_USERS defaults to 100 and the two suites together create about fifteen
 * seats per run, so without a sweep they eat the operator's seat allowance and
 * then start failing on `seat limit reached` -- which reads like a product bug
 * and is actually the tests' own litter.
 */
const TEST_EMAIL = /^(?:smoke|burst|quota|credit|low|idle|rev|oauth|cascade)-.*@example\.com$/;

console.log(`\n=== KD JEV MCP OAuth 2.1 test -> ${BASE} ===\n`);

/** Revoke seats left behind by earlier runs. Operator path only; real seats are never matched. */
async function sweepTestSeats() {
  const listed = await get("/api/admin/tokens", {
    headers: { "x-admin-passkey": PK || "" },
  });
  const strays = (listed.json?.tokens ?? []).filter((t) => TEST_EMAIL.test(t.email) && t.status === "active");
  for (const t of strays) {
    await admin({ action: "revoke", email: t.email });
  }
  if (strays.length) console.log(`  (swept ${strays.length} test seat(s) left by earlier runs)`);
  return strays.length;
}
await sweepTestSeats();

// ------------------------------------------------------------- discovery
section("discovery documents");
{
  const pr = await get("/.well-known/oauth-protected-resource");
  check("protected-resource doc returns 200", pr.status === 200, `got ${pr.status}`);
  check("resource points at /mcp", pr.json?.resource === `${BASE}/mcp`, JSON.stringify(pr.json?.resource));
  check("authorization_servers lists this origin", pr.json?.authorization_servers?.[0] === BASE);
  check("advertises header bearer method", pr.json?.bearer_methods_supported?.includes("header"));
  check("scopes_supported includes mcp", pr.json?.scopes_supported?.includes("mcp"));

  const as = await get("/.well-known/oauth-authorization-server");
  check("AS metadata returns 200", as.status === 200, `got ${as.status}`);
  check("issuer matches origin", as.json?.issuer === BASE, String(as.json?.issuer));
  check("only S256 is offered", JSON.stringify(as.json?.code_challenge_methods_supported) === '["S256"]');
  check("authorization_code grant advertised", as.json?.grant_types_supported?.includes("authorization_code"));
  check("refresh_token grant advertised", as.json?.grant_types_supported?.includes("refresh_token"));
  check("registration_endpoint advertised for DCR", as.json?.registration_endpoint === `${BASE}/register`);
}

// ------------------------------------------------------- 401 challenge
section("unauthenticated challenge");
{
  const r = await mcpCall("", { jsonrpc: "2.0", id: 1, method: "tools/list" });
  check("no bearer -> 401", r.status === 401, `got ${r.status}`);
  const wa = r.headers.get("www-authenticate") || "";
  check("WWW-Authenticate header present", wa.startsWith("Bearer"), wa.slice(0, 60));
  check("challenge carries resource_metadata", wa.includes("resource_metadata="), wa.slice(0, 120));
  check("body points at the metadata document", r.json?.resource_metadata === `${BASE}/.well-known/oauth-protected-resource`);
  check("body suggests the OAuth path", /oauth/i.test(r.json?.hint || ""));
}

// ------------------------------------------------------ gateway token
section("gateway token fixture");
let token;
{
  const r = await admin({
    action: "create",
    email: EMAIL,
    label: "OAuth test",
    credits: 500,
    rate_limit_per_min: 60,
  });
  token = r.json?.token;
  check("admin issued a token", r.status === 200 && typeof token === "string", JSON.stringify(r.json).slice(0, 120));
  check("token has the kdj_ prefix", !!token && token.startsWith("kdj_"));
  check("grant is in KD Credit", r.json?.credits === 500, JSON.stringify(r.json?.credits));
}

// ------------------------------------------------------- DCR (register)
section("dynamic client registration");
let clientId;
{
  const bad = await postForm("/register", { redirect_uris: "[]" });
  check("register without redirect_uris -> 400", bad.status === 400, `got ${bad.status}`);

  const insecure = await postForm("/register", {
    redirect_uris: JSON.stringify(["http://evil.example.com/cb"]),
    client_name: "insecure",
  });
  check("plain http non-loopback redirect_uri rejected", insecure.status === 400, `got ${insecure.status}`);
  check("rejection names the reason", /http/i.test(insecure.json?.error_description || ""));

  const malformed = await postForm("/register", { redirect_uris: JSON.stringify(["not a url"]) });
  check("malformed redirect_uri rejected", malformed.status === 400, `got ${malformed.status}`);

  const get1 = await get("/register");
  check("register via GET -> 405", get1.status === 405, `got ${get1.status}`);

  const r = await postForm("/register", {
    redirect_uris: JSON.stringify([REDIRECT]),
    client_name: "OAuth test client",
    grant_types: JSON.stringify(["authorization_code", "refresh_token"]),
    token_endpoint_auth_method: "none",
    scope: "mcp",
  });
  clientId = r.json?.client_id;
  check("register returns 201", r.status === 201, `got ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
  check("client_id issued", typeof clientId === "string" && clientId.startsWith("kdjo_"), String(clientId));
  check("public client gets no secret", r.json?.client_secret === undefined);
  check("client_name echoed", r.json?.client_name === "OAuth test client");
  check("response_types is code", JSON.stringify(r.json?.response_types) === '["code"]');

  const dup = await postForm("/register", {
    redirect_uris: JSON.stringify([REDIRECT]),
    client_name: "OAuth test client",
  });
  check("each registration gets a distinct client_id", dup.json?.client_id && dup.json.client_id !== clientId);
}

// ----------------------------------------------------- consent screen
section("authorization request");
const pkce = makePkce();
const STATE = "state-" + randomBytes(6).toString("hex");
let authQuery;
{
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: "mcp",
    state: STATE,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    resource: `${BASE}/mcp`,
  });
  authQuery = q;

  const noS256 = await get("/authorize?" + new URLSearchParams({
    client_id: clientId, redirect_uri: REDIRECT, response_type: "code",
    code_challenge: pkce.challenge, code_challenge_method: "plain",
  }));
  const errLoc = noS256.headers.get("location") || "";
  check("plain code_challenge_method refused", noS256.status === 302 && errLoc.includes("error=invalid_request"), `${noS256.status} ${errLoc.slice(0, 80)}`);

  const badRedirect = await get("/authorize?" + new URLSearchParams({
    client_id: clientId, redirect_uri: "http://127.0.0.1:55999/other",
    response_type: "code", code_challenge: pkce.challenge, code_challenge_method: "S256",
  }));
  check("unregistered redirect_uri -> 400", badRedirect.status === 400, `got ${badRedirect.status}`);

  const badClient = await get("/authorize?" + new URLSearchParams({
    client_id: "kdjo_nope", redirect_uri: REDIRECT, response_type: "code",
    code_challenge: pkce.challenge, code_challenge_method: "S256",
  }));
  check("unknown client_id -> 400", badClient.status === 400, `got ${badClient.status}`);

  const page = await get("/authorize?" + q.toString());
  check("consent page returns 200", page.status === 200, `got ${page.status}`);
  check("consent page is HTML", (page.headers.get("content-type") || "").includes("text/html"));
  check("consent page is not cacheable", (page.headers.get("cache-control") || "").includes("no-store"));
  check("consent page names the client", page.text.includes("OAuth test client"));
  // The bug that CONSENT_FIELDS documents: these four must survive the round trip.
  check("consent form carries client_id", page.text.includes('name="client_id"'));
  check("consent form carries redirect_uri", page.text.includes('name="redirect_uri"'));
  check("consent form carries code_challenge", page.text.includes('name="code_challenge"'));
  check("consent form carries code_challenge_method", page.text.includes('name="code_challenge_method"'));
  check("consent form carries state", page.text.includes(`value="${STATE}"`));
}

// -------------------------------------------------- identity is both parts
section("consent requires email AND token");
{
  const bad = await postForm("/authorize", {
    ...Object.fromEntries(authQuery),
    email: EMAIL,
    token: "kdj_wrong_wrong_wrong_wrong_wrong",
  });
  check("wrong token -> 401", bad.status === 401, `got ${bad.status}`);
  check("no code leaked on failure", !(bad.headers.get("location") || "").includes("code="));
  check("page explains the failure", /do not match/i.test(bad.text));

  const wrongEmail = await postForm("/authorize", {
    ...Object.fromEntries(authQuery),
    email: `someone-else-${Date.now()}@example.com`,
    token,
  });
  check("right token but wrong email -> 401", wrongEmail.status === 401, `got ${wrongEmail.status}`);

  const noEmail = await postForm("/authorize", { ...Object.fromEntries(authQuery), token });
  check("token without email -> 401", noEmail.status === 401, `got ${noEmail.status}`);
}

// ---------------------------------------------------------- code issued
section("authorization code");
let code;
{
  const r = await postForm("/authorize", {
    ...Object.fromEntries(authQuery),
    email: EMAIL,
    token,
  });
  const loc = codeFromRedirect(r);
  check("consent accepted -> 302", r.status === 302, `got ${r.status}`);
  check("redirects to the registered redirect_uri", loc && loc.origin + loc.pathname === REDIRECT, String(loc));
  check("carries a code", !!loc?.searchParams.get("code"), String(loc?.searchParams.get("code")));
  check("state echoed back intact", loc?.searchParams.get("state") === STATE, String(loc?.searchParams.get("state")));
  code = loc?.searchParams.get("code") || "";
}

// -------------------------------------------------------- PKCE exchange
section("token endpoint (authorization_code + PKCE)");
let accessToken;
let refreshToken;
{
  const wrongVerifier = await postForm("/token", {
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: b64url(randomBytes(48)),
  });
  check("wrong code_verifier -> 400", wrongVerifier.status === 400, `got ${wrongVerifier.status}`);
  check("reported as invalid_grant", wrongVerifier.json?.error === "invalid_grant", JSON.stringify(wrongVerifier.json));
  check("no token issued on PKCE failure", !wrongVerifier.json?.access_token);

  const r = await postForm("/token", {
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: pkce.verifier,
    resource: `${BASE}/mcp`,
  });
  accessToken = r.json?.access_token;
  refreshToken = r.json?.refresh_token;
  check("exchange returns 200", r.status === 200, `got ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
  check("access_token issued", typeof accessToken === "string" && accessToken.length > 20);
  check("token_type is Bearer", r.json?.token_type === "Bearer");
  check("expires_in is ~1h", Math.abs(r.json?.expires_in - 3600) < 30, String(r.json?.expires_in));
  check("refresh_token issued", typeof refreshToken === "string" && refreshToken.length > 20);
  check("scope echoed", r.json?.scope === "mcp");
  check("resource echoed", r.json?.resource === `${BASE}/mcp`);
  check("response is not cacheable", (r.headers.get("cache-control") || "").includes("no-store"));

  const replay = await postForm("/token", {
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: pkce.verifier,
  });
  check("authorization code cannot be replayed", replay.json?.error === "invalid_grant", JSON.stringify(replay.json));

  const fake = await postForm("/token", {
    grant_type: "authorization_code",
    code: "totally-made-up-code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: pkce.verifier,
  });
  check("unknown code -> invalid_grant", fake.json?.error === "invalid_grant");

  const badClient = await postForm("/token", {
    grant_type: "authorization_code",
    code,
    client_id: "kdjo_someone_else",
    redirect_uri: REDIRECT,
    code_verifier: pkce.verifier,
  });
  check("unknown client at /token -> 401", badClient.status === 401, `got ${badClient.status}`);

  const mismatchedRedirect = await postForm("/token", {
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:55999/somewhere-else",
    code_verifier: pkce.verifier,
  });
  check("redirect_uri mismatch refused", mismatchedRedirect.json?.error === "invalid_grant");
}

// ------------------------------------------------ OAuth token works on MCP
section("OAuth access token against the data plane");
{
  const anon = await get("/api/whoami");
  check("whoami without token -> 401", anon.status === 401, `got ${anon.status}`);

  const r = await get("/api/whoami", { headers: { authorization: `Bearer ${accessToken}` } });
  check("whoami with OAuth access token -> 200", r.status === 200, `got ${r.status}`);
  check("email resolves to the token owner", r.json?.email === EMAIL, String(r.json?.email));
  check("provenance reported as oauth", r.json?.authenticated_via === "oauth", String(r.json?.authenticated_via));
  check("client name reported", r.json?.client?.name === "OAuth test client", JSON.stringify(r.json?.client));
  check("client_id reported", r.json?.client?.client_id?.startsWith("kdjo_") === true, JSON.stringify(r.json?.client));
  check("access token expiry surfaced", typeof r.json?.access_token_expires_at === "number", String(r.json?.access_token_expires_at));

  const init = await mcpCall(accessToken, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "oauth-test", version: "1.0.0" } },
  });
  check("MCP initialize over OAuth -> 200", init.status === 200, `got ${init.status} ${init.text.slice(0, 120)}`);
  check("initialize returns a protocol version", !!init.json?.result?.protocolVersion, init.text.slice(0, 120));

  const tools = await mcpCall(accessToken, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  check("tools/list over OAuth -> 200", tools.status === 200, `got ${tools.status}`);
  const names = (tools.json?.result?.tools || []).map((t) => t.name);
  check("JEV tools are exposed", ["choice", "noul", "score"].every((n) => names.includes(n)), names.join(","));
  check("help tool exposed", names.includes("help"), names.join(","));

  const usage = await get("/api/usage", { headers: { authorization: `Bearer ${accessToken}` } });
  check("usage endpoint works for OAuth identity", usage.status === 200, `got ${usage.status}`);
  check("usage is attributed to the email", usage.json?.email === EMAIL, JSON.stringify(usage.json).slice(0, 160));
}

// ---------------------------------------------------- refresh rotation
section("refresh token rotation");
let rotatedAccess;
let rotatedRefresh;
{
  const r = await postForm("/token", {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  rotatedAccess = r.json?.access_token;
  rotatedRefresh = r.json?.refresh_token;
  check("refresh returns 200", r.status === 200, `got ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
  check("a new access_token is issued", typeof rotatedAccess === "string" && rotatedAccess.length > 20);
  check("a new refresh_token is issued", typeof rotatedRefresh === "string" && rotatedRefresh.length > 20);
  check("access token actually changed", rotatedAccess !== accessToken);
  check("refresh token actually changed", rotatedRefresh !== refreshToken);

  const replay = await postForm("/token", {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  check("old refresh token is dead after rotation", replay.json?.error === "invalid_grant", JSON.stringify(replay.json));

  // Stricter than RFC 6749 requires, deliberately: rotation revokes the old
  // *access* token too, not just the refresh token. The cost is that a request
  // already in flight on the pre-refresh access token gets a 401. The benefit is
  // that a leaked refresh token has a one-use lifetime and an AS-issued session
  // can be cut short by forcing a refresh. Asserted here so the behaviour cannot
  // change silently.
  const old = await get("/api/whoami", { headers: { authorization: `Bearer ${accessToken}` } });
  check("rotation also retires the old access token", old.status === 401, `got ${old.status}`);

  const fresh = await get("/api/whoami", { headers: { authorization: `Bearer ${rotatedAccess}` } });
  check("rotated access token works", fresh.status === 200, `got ${fresh.status}`);

  const noRefresh = await postForm("/token", { grant_type: "refresh_token", client_id: clientId });
  check("refresh without token -> 400", noRefresh.status === 400, `got ${noRefresh.status}`);

  const badGrant = await postForm("/token", { grant_type: "client_credentials", client_id: clientId });
  check("client_credentials is not offered", badGrant.json?.error === "unsupported_grant_type", JSON.stringify(badGrant.json));
}

// --------------------------------------------------- OAuth identity = money
//
// The property that makes the whole credit model coherent: an OAuth access token
// is an *identity*, never a second bill. It must draw on its holder's balance, so
// a user cannot gain capacity by connecting an extra client.
//
// Placed BEFORE the revocation section, which is deliberate: revoking a refresh
// token kills the whole family (asserted below), so after that point every OAuth
// credential for this account is legitimately dead and these checks would 401 --
// pass or fail for the wrong reason entirely.
section("an OAuth session spends its holder's balance, not a new one");
{
  // Must be the POST-ROTATION token: the refresh section above deliberately
  // retired the original access token.
  check("using the rotated session, not the retired one", typeof rotatedAccess === "string" && rotatedAccess !== accessToken);

  const who = await get("/api/whoami", { headers: { authorization: `Bearer ${token}` } });
  const directBefore = await get("/api/usage", { headers: { authorization: `Bearer ${token}` } });
  const viaBefore = await get("/api/usage", { headers: { authorization: `Bearer ${rotatedAccess}` } });

  check("bearer resolves to the holder", who.json?.email === EMAIL, JSON.stringify(who.json));
  check(
    "OAuth session resolves too, not just the bearer token",
    viaBefore.status === 200,
    `got ${viaBefore.status} ${JSON.stringify(viaBefore.json).slice(0, 120)}`,
  );

  check(
    "same balance seen through both credentials",
    directBefore.json?.credits?.available === viaBefore.json?.credits?.available,
    `bearer ${directBefore.json?.credits?.available} vs oauth ${viaBefore.json?.credits?.available}`,
  );
  check(
    "same health through both credentials",
    directBefore.json?.health === viaBefore.json?.health,
    `${directBefore.json?.health} vs ${viaBefore.json?.health}`,
  );
  check(
    "OAuth session is not separately metered",
    viaBefore.json?.calls_this_period === directBefore.json?.calls_this_period,
    `${viaBefore.json?.calls_this_period} vs ${directBefore.json?.calls_this_period}`,
  );

  // A call made through the OAuth token must move the one shared balance. If
  // grants were billed separately this would silently double a user's capacity,
  // which is precisely the bug a metered gateway exists to prevent.
  const spent = await mcpCall(rotatedAccess, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "noul", arguments: { state: "The shared balance question", instructions: "Is this a statement?" } },
  });
  check("call via OAuth token succeeds", spent.status === 200, `got ${spent.status}`);

  const directAfter = await get("/api/usage", { headers: { authorization: `Bearer ${token}` } });
  check(
    "OAuth spend shows up on the bearer balance",
    directAfter.json?.credits?.used > directBefore.json?.credits?.used,
    `${directBefore.json?.credits?.used} -> ${directAfter.json?.credits?.used}`,
  );

  // The no-prices rule must hold through the second door as well. A credential
  // path added later is exactly where such a leak would sneak in.
  const raw = JSON.stringify(viaBefore.json);
  check("OAuth usage leaks no currency either", !/\bmyr\b/i.test(raw) && !/\busd\b/i.test(raw), raw.slice(0, 160));
}

// ------------------------------------------------------------ revocation
section("revocation");
{
  const r = await postForm("/revoke", { token: rotatedRefresh, client_id: clientId });
  check("revoke returns 200", r.status === 200, `got ${r.status}`);

  const after = await get("/api/whoami", { headers: { authorization: `Bearer ${rotatedAccess}` } });
  check("revoked access token stops working", after.status === 401, `got ${after.status}`);

  const again = await postForm("/revoke", { token: "never-existed", client_id: clientId });
  check("revoking an unknown token still returns 200 (RFC 7009)", again.status === 200, `got ${again.status}`);
}

// --------------------------------- gateway revocation kills OAuth sessions
section("revoking the gateway token kills its OAuth sessions");
{
  const r = await admin({ action: "create", email: `cascade-${Date.now()}@example.com`, label: "Cascade", credits: 10 });
  const cascadeEmail = r.json?.email;
  const cascadeToken = r.json?.token;

  const reg = await postForm("/register", { redirect_uris: JSON.stringify([REDIRECT]), client_name: "Cascade client" });
  const cascadeClient = reg.json?.client_id;

  const p = makePkce();
  const q = new URLSearchParams({
    client_id: cascadeClient,
    redirect_uri: REDIRECT,
    response_type: "code",
    state: "cascade",
    code_challenge: p.challenge,
    code_challenge_method: "S256",
  });
  const cons = await postForm("/authorize", { ...Object.fromEntries(q), email: cascadeEmail, token: cascadeToken });
  const cascadeCode = codeFromRedirect(cons)?.searchParams.get("code");

  const tok = await postForm("/token", {
    grant_type: "authorization_code",
    code: cascadeCode,
    client_id: cascadeClient,
    redirect_uri: REDIRECT,
    code_verifier: p.verifier,
  });
  const cascadeAccess = tok.json?.access_token;
  check("cascade fixture got an OAuth session", typeof cascadeAccess === "string", JSON.stringify(tok.json).slice(0, 120));

  const before = await get("/api/whoami", { headers: { authorization: `Bearer ${cascadeAccess}` } });
  check("cascade session works before revocation", before.status === 200, `got ${before.status}`);

  await admin({ action: "revoke", email: cascadeEmail });

  const after = await get("/api/whoami", { headers: { authorization: `Bearer ${cascadeAccess}` } });
  check("OAuth session dies with its gateway token", after.status === 401, `got ${after.status}`);

  const refreshed = await postForm("/token", {
    grant_type: "refresh_token",
    refresh_token: tok.json?.refresh_token,
    client_id: cascadeClient,
  });
  check("refresh cannot resurrect a revoked account", refreshed.json?.error === "invalid_grant", JSON.stringify(refreshed.json));
}

// --------------------------------------------------------------- grants
section("admin grant listing");
{
  const r = await get("/api/admin/grants", { headers: { "x-admin-passkey": PK || "" } });
  check("grant listing requires and accepts the admin passkey", r.status === 200, `got ${r.status}`);
  const anon = await get("/api/admin/grants");
  check("grant listing is closed to anonymous callers", anon.status === 401, `got ${anon.status}`);
  const wrong = await get("/api/admin/grants", { headers: { "x-admin-passkey": "nope" } });
  check("grant listing rejects a wrong passkey", wrong.status === 401, `got ${wrong.status}`);
}

// --------------------------------------------------------------- summary
console.log(`\n${"=".repeat(56)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) {
  console.log(`\n  failing assertions:`);
  for (const f of failures) console.log(`    - ${f}`);
}
console.log(`${"=".repeat(56)}\n`);
process.exit(fail ? 1 : 0);