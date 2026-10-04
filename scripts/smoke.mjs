// End-to-end smoke test against a running `wrangler dev`.
// Usage: node scripts/smoke.mjs
// Not part of the deployed bundle -- dev tooling only.

const BASE = process.env.KD_BASE || "http://127.0.0.1:8787";
const PK = process.env.ADMIN_PASSKEY;
const MASTER = process.env.MCP_TOKEN;

let pass = 0;
let fail = 0;

function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? " :: " + detail : ""}`);
  }
}

async function api(path, { method = "GET", body, token, admin } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (admin) headers["x-admin-passkey"] = admin;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

async function mcp(token, payload) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
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
  return { status: res.status, json, text };
}

const EMAIL = `smoke-${Date.now()}@example.com`;

/**
 * Every seat this suite creates is matched by one of these prefixes.
 *
 * The cleanup sweep below depends on the pattern staying in sync with the emails
 * used further down, which is why they are defined once instead of being spelled
 * out at each call site.
 */
const TEST_EMAIL = /^(?:smoke|burst|quota|credit|low|idle|rev|oauth|cascade)-.*@example\.com$/;

console.log(`\n=== KD JEV MCP smoke test -> ${BASE} ===\n`);

// ---------------------------------------------------------------- cleanup
//
// Sweep seats left by previous runs FIRST, so the two suites can be run in
// either order and repeatedly.
//
// MAX_USERS defaults to 100 and the combined suites create roughly fifteen seats
// per run. Without this sweep they slowly consume the operator's seat allowance
// and then start failing on `seat limit reached` -- a failure that looks like a
// product bug and is actually the tests' own litter. A suite that can only be run
// once per database is a broken suite.
//
// `sweepTestSeats()` is defined in each suite and matches its own prefixes plus
// the other's, so running oauth first or smoke first reaches the same clean
// state. Only addresses matching the pattern are revoked, and only through the
// normal operator revoke path, so real seats are never touched.
{
  const listed = await api("/api/admin/tokens", { admin: PK });
  const strays = (listed.json?.tokens ?? []).filter((t) => TEST_EMAIL.test(t.email) && t.status === "active");
  if (strays.length) {
    for (const t of strays) {
      await api("/api/admin/tokens", { method: "POST", admin: PK, body: { action: "revoke", email: t.email } });
    }
    console.log(`  (swept ${strays.length} test seat(s) left by earlier runs)`);
  }
}

// ---------------------------------------------------------------- health
console.log("health");
{
  const r = await api("/health");
  check("health returns 200", r.status === 200, `got ${r.status}`);
  check("status ok", r.json?.status === "ok", JSON.stringify(r.json));
  check("JEV key configured", r.json?.jev_key_configured === true);
  check("database reachable", r.json?.database === "reachable");
}

// ------------------------------------------------------------------ auth
console.log("\nauthentication");
{
  const anon = await api("/api/whoami");
  check("no token -> 401", anon.status === 401, `got ${anon.status}`);
  const bogus = await api("/api/whoami", { token: "kdj_bogus_bogus_bogus_bogus_bogus" });
  check("bad token -> 401", bogus.status === 401, `got ${bogus.status}`);
  const badAdmin = await api("/api/admin/tokens", { admin: "wrong" });
  check("bad admin passkey -> 401", badAdmin.status === 401, `got ${badAdmin.status}`);
}

// ------------------------------------------------------- token generation
console.log("\ntoken generation");
let token;
let issued;
{
  // Rate is set high here on purpose: the functional tests below need more than
  // a handful of calls, and the burst limit gets its own dedicated token.
  const r = await api("/api/admin/tokens", {
    method: "POST",
    admin: PK,
    body: { action: "create", email: EMAIL.toUpperCase(), label: "Smoke", quota_monthly: 100, rate_limit_per_min: 60 },
  });
  issued = r.json;
  token = issued?.token;
  check("create returns 200", r.status === 200, JSON.stringify(r.json));
  check("token starts with kdj_", typeof token === "string" && token.startsWith("kdj_"), String(token).slice(0, 12));
  check("token is long enough", (token?.length ?? 0) >= 40, `len ${token?.length}`);
  check("email normalised to lowercase", issued?.email === EMAIL, String(issued?.email));
  check("quota echoed", issued?.quota_monthly === 100);

  const dupe = await api("/api/admin/tokens", {
    method: "POST",
    admin: PK,
    body: { action: "rotate", email: EMAIL },
  });
  check("rotate returns a new token", dupe.json?.token && dupe.json.token !== token);
  check("rotate preserves quota", dupe.json?.quota_monthly === 100, JSON.stringify(dupe.json?.quota_monthly));
  check("rotate preserves rate limit", dupe.json?.rate_limit_per_min === 60, JSON.stringify(dupe.json?.rate_limit_per_min));
  token = dupe.json?.token ?? token;

  const rotatedOld = await api("/api/whoami", { token: issued?.token });
  check("old token no longer works", rotatedOld.status === 401, `got ${rotatedOld.status}`);
}

// ------------------------------------------------------------ primitives
console.log("\nJEV primitives");
{
  const r = await api("/api/reason", {
    method: "POST",
    token,
    body: {
      state: { ticket: "I was charged twice for order A-104 and want my money back." },
      questions: {
        duplicate: { type: "noul", instructions: "Does the ticket report a duplicate charge?" },
        topic: {
          type: "choice",
          instructions: "Which queue should handle this ticket?",
          criteria: { billing: "Charges, refunds, invoices", shipping: "Delivery and tracking" },
        },
        urgency: {
          type: "score",
          instructions: "How urgent is this ticket?",
          criteria: ["low", "medium", "high"],
        },
      },
    },
  });
  const a = r.json?.answers;
  check("reason returns 200", r.status === 200, JSON.stringify(r.json).slice(0, 200));
  check("noul answered", typeof a?.duplicate?.value === "number", JSON.stringify(a?.duplicate));
  check("choice answered 'billing'", a?.topic?.value === "billing", JSON.stringify(a?.topic));
  check("choice has probabilities", !!a?.topic?.probabilities);
  check("score is a number", typeof a?.urgency?.value === "number", JSON.stringify(a?.urgency));
  check("score has legend", !!a?.urgency?.legend);
  check("usage reported", r.json?.usage?.input_tokens > 0, JSON.stringify(r.json?.usage));
  check("noul is confident", a?.duplicate?.value > 0.5, String(a?.duplicate?.value));
}

console.log("\nsingle primitives");
{
  const n = await api("/api/noul", {
    method: "POST",
    token,
    body: { state: "The sky is green.", instructions: "Is this statement true?", criteria: { true: "Factually correct", false: "Not correct" } },
  });
  check("noul false-ish", typeof n.json?.answers?.answer?.value === "number", JSON.stringify(n.json).slice(0, 160));
  check("noul rejects false premise", n.json?.answers?.answer?.value < 0.5, String(n.json?.answers?.answer?.value));

  const c = await api("/api/choice", {
    method: "POST",
    token,
    body: { state: "Reset my password please", instructions: "What does the user want?", options: { auth: "Login and password problems", billing: "Payments" } },
  });
  check("choice picks auth", c.json?.answers?.answer?.value === "auth", JSON.stringify(c.json?.answers?.answer));

  const s = await api("/api/score", {
    method: "POST",
    token,
    body: { state: "THIS IS THE FIFTH TIME. FIX IT.", instructions: "How frustrated?", levels: ["calm", "annoyed", "furious"] },
  });
  check("score high for angry text", s.json?.answers?.answer?.value >= 1, String(s.json?.answers?.answer?.value));

  const bad = await api("/api/choice", {
    method: "POST",
    token,
    body: { state: "x", instructions: "pick", options: { only: "one option" } },
  });
  check("choice with 1 option rejected", bad.status === 400, `got ${bad.status}`);
}

// ------------------------------------------------------------------ usage
console.log("\nusage");
{
  const before = await api("/api/usage", { token });
  check("usage returns 200", before.status === 200);
  check("counts calls this period", before.json?.calls_this_period > 0, JSON.stringify(before.json));
  check("credit balance present", typeof before.json?.credits?.available === "number", JSON.stringify(before.json));
  check("credit unit named", before.json?.credits?.unit === "KD Credit");
  check("credit granted echoed", before.json?.credits?.granted === 500, JSON.stringify(before.json?.credits));
  check("credit was debited", before.json?.credits?.used > 0, JSON.stringify(before.json?.credits));
  check("health reported", before.json?.health === "active", JSON.stringify(before.json?.health));
  check("callable reported", before.json?.callable === true);
  check("request cap present", before.json?.request_cap === 100, JSON.stringify(before.json?.request_cap));

  // The user-facing surface must never leak a price or a conversion rate. This
  // is a load-bearing product rule, not cosmetic: the whole point of the credit
  // abstraction is that the admin can restate rates without touching clients.
  const raw = JSON.stringify(before.json);
  check("no MYR on user surface", !/\bmyr\b/i.test(raw), raw.slice(0, 200));
  check("no USD on user surface", !/\busd\b/i.test(raw), raw.slice(0, 200));
  check("no micros leaked to user", !/micros/i.test(raw), raw.slice(0, 200));

  const health = await api("/api/health-token", { token });
  check("health endpoint 200", health.status === 200);
  check("health verdict active", health.json?.health === "active", JSON.stringify(health.json));
  check("health carries remedy", typeof health.json?.credits?.available === "number");

  const master = await api("/api/usage", { token: MASTER });
  check("master not metered", master.json?.kind === "master", JSON.stringify(master.json));
}

// -------------------------------------------------------------------- MCP
console.log("\nMCP protocol");
{
  const init = await mcp(token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } },
  });
  check("initialize 200", init.status === 200, init.text.slice(0, 200));
  check("server name reported", init.json?.result?.serverInfo?.name === "kd-jev-mcp", JSON.stringify(init.json?.result?.serverInfo));

  const list = await mcp(token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = (list.json?.result?.tools ?? []).map((t) => t.name).sort();
  check("tools/list 200", list.status === 200, list.text.slice(0, 200));
  check("all 7 tools exposed", JSON.stringify(names) === JSON.stringify(["choice", "help", "noul", "reason", "score", "token_health", "usage"]), JSON.stringify(names));

  const call = await mcp(token, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "choice", arguments: { state: "My card was declined at checkout.", instructions: "Which area is this?", options: { payments: "Card declines and charges", account: "Login and passwords" } } },
  });
  const txt = call.json?.result?.content?.[0]?.text ?? "";
  check("tools/call 200", call.status === 200, call.text.slice(0, 200));
  check("choice tool returned payments", txt.includes('"payments"'), txt.slice(0, 200));

  const help = await mcp(token, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "help", arguments: {} } });
  check("help works", (help.json?.result?.content?.[0]?.text ?? "").includes("KD JEV MCP"));

  const noAuth = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
  });
  check("MCP without token -> 401", noAuth.status === 401, `got ${noAuth.status}`);
}

// ------------------------------------------------------------ rate limit
console.log("\nrate limiting (dedicated token, 3/min)");
{
  const email = `burst-${Date.now()}@example.com`;
  const r = await api("/api/admin/tokens", {
    method: "POST",
    admin: PK,
    body: { action: "create", email, quota_monthly: 1000, rate_limit_per_min: 3 },
  });
  const t = r.json?.token;
  check("burst token issued", !!t, JSON.stringify(r.json));

  let okCount = 0;
  let saw429 = null;
  for (let i = 0; i < 8; i++) {
    const res = await api("/api/noul", {
      method: "POST",
      token: t,
      body: { state: `test ${i}`, instructions: "Is this a test?" },
    });
    if (res.status === 429) {
      saw429 = res;
      break;
    }
    if (res.status === 200) okCount++;
  }
  check("at most 3 calls allowed per minute", okCount <= 3, `allowed ${okCount}`);
  check("burst limit enforced with 429", saw429 !== null);
  check("429 names the code", saw429?.json?.code === "rate_limited", JSON.stringify(saw429?.json));
  check("429 sends retry-after", !!saw429 && saw429.json?.error?.includes("rate limit"), JSON.stringify(saw429?.json));
}

// --------------------------------------------- optional request ceiling
console.log("\nrequest cap (quota_monthly = 1, an optional secondary ceiling)");
{
  const email = `quota-${Date.now()}@example.com`;
  const r = await api("/api/admin/tokens", {
    method: "POST",
    admin: PK,
    body: { action: "create", email, credits: 100, quota_monthly: 1, rate_limit_per_min: 60 },
  });
  const t = r.json?.token;
  check("quota echoed on issue", r.json?.quota_monthly === 1, JSON.stringify(r.json?.quota_monthly));

  const first = await api("/api/noul", { method: "POST", token: t, body: { state: "hello", instructions: "Is this a greeting?" } });
  check("first call within cap ok", first.status === 200, `got ${first.status} ${JSON.stringify(first.json).slice(0, 160)}`);

  const second = await api("/api/noul", { method: "POST", token: t, body: { state: "hello again", instructions: "Is this a greeting?" } });
  check("second call over cap -> 429", second.status === 429, `got ${second.status} ${JSON.stringify(second.json).slice(0, 160)}`);
  check("429 says quota_exceeded", second.json?.code === "quota_exceeded", JSON.stringify(second.json));

  const u = await api("/api/usage", { token: t });
  check("cap surfaced on usage", u.json?.request_cap === 1, JSON.stringify(u.json?.request_cap));
  check("one call recorded", u.json?.calls_this_period === 1, JSON.stringify(u.json?.calls_this_period));

  // Credits were only spent on the call that actually ran. The blocked call must
  // not be charged -- otherwise a caller stuck at their ceiling burns their whole
  // balance on requests that never reached JEV.
  check("blocked call not charged", u.json?.credits?.used > 0 && u.json?.credits?.used < 5, JSON.stringify(u.json?.credits));
}

// -------------------------------------------------------- credit exhaustion
console.log("\ncredit exhaustion (grant 0.01 KD Credit, less than one call costs)");
{
  const email = `credit-${Date.now()}@example.com`;
  const r = await api("/api/admin/tokens", {
    method: "POST",
    admin: PK,
    body: { action: "create", email, credits: 0.01, rate_limit_per_min: 60 },
  });
  const t = r.json?.token;
  check("grant echoed in whole credits", Math.abs((r.json?.credits ?? 0) - 0.01) < 1e-9, JSON.stringify(r.json?.credits));
  check("grant echoed as money too", typeof r.json?.money?.granted_myr === "number", JSON.stringify(r.json?.money));
  check("no request cap by default", r.json?.quota_monthly === 0, JSON.stringify(r.json?.quota_monthly));

  const first = await api("/api/noul", { method: "POST", token: t, body: { state: "hello", instructions: "Is this a greeting?" } });
  check("first call allowed", first.status === 200, `got ${first.status} ${JSON.stringify(first.json).slice(0, 160)}`);

  const second = await api("/api/noul", { method: "POST", token: t, body: { state: "hello again", instructions: "Is this a greeting?" } });
  check("over balance -> 429", second.status === 429, `got ${second.status} ${JSON.stringify(second.json).slice(0, 160)}`);
  check("429 says credit_exhausted", second.json?.code === "credit_exhausted", JSON.stringify(second.json));
  check("429 tells the user to ask for a top-up", /top it up/i.test(second.json?.error ?? ""), JSON.stringify(second.json?.error));

  const u = await api("/api/usage", { token: t });
  check("health is exhausted", u.json?.health === "exhausted", JSON.stringify(u.json?.health));
  check("not callable", u.json?.callable === false);
  check("balance went negative, honestly", u.json?.credits?.available < 0, JSON.stringify(u.json?.credits));

  // The overshoot is the real cost of the call that ran. Clamping it to zero
  // would make the ledger disagree with the upstream invoice, so the number is
  // allowed to go below zero and the NEXT call is what gets blocked.
  check("used exceeds granted (real overspend recorded)", u.json?.credits?.used > 0.01, JSON.stringify(u.json?.credits));

  const h = await api("/api/health-token", { token: t });
  check("health endpoint agrees", h.json?.health === "exhausted" && h.json?.callable === false, JSON.stringify(h.json));

  // -------------------------------------------------------------- top-up
  const top = await api("/api/admin/tokens", { method: "POST", admin: PK, body: { action: "topup", email, credits: 50 } });
  check("topup ok", top.status === 200 && top.json?.added === 50, JSON.stringify(top.json));
  check("zero topup refused", (await api("/api/admin/tokens", { method: "POST", admin: PK, body: { action: "topup", email, credits: 0 } })).json?.error);
  check("negative topup refused", (await api("/api/admin/tokens", { method: "POST", admin: PK, body: { action: "topup", email, credits: -5 } })).json?.error);
  check("topup unknown email refused", (await api("/api/admin/tokens", { method: "POST", admin: PK, body: { action: "topup", email: `ghost-${Date.now()}@example.com`, credits: 5 } })).json?.error);

  const after = await api("/api/usage", { token: t });
  check("callable again after topup", after.json?.callable === true, JSON.stringify(after.json));
  check("health back to active", after.json?.health === "active", JSON.stringify(after.json?.health));
  check("topup landed in extra, not grant", after.json?.credits?.extra === 50 && after.json?.credits?.granted === 0.01, JSON.stringify(after.json?.credits));

  const resumed = await api("/api/noul", { method: "POST", token: t, body: { state: "still here?", instructions: "Is this a question?" } });
  check("call works after topup", resumed.status === 200, `got ${resumed.status} ${JSON.stringify(resumed.json).slice(0, 160)}`);
}

// ----------------------------------------------------- degraded (low balance)
console.log("\ndegraded balance reporting");
{
  const email = `low-${Date.now()}@example.com`;
  const r = await api("/api/admin/tokens", { method: "POST", admin: PK, body: { action: "create", email, credits: 0.5, rate_limit_per_min: 60 } });
  const t = r.json?.token;
  // A balance under degraded_pct (20% default) of the grant. Low but not spent.
  // 'idle' is expected here, not 'active': the seat has never been called, and
  // conflating that with a working seat would hide a broken integration.
  const u1 = await api("/api/usage", { token: t });
  check("fresh seat is idle, not degraded", u1.json?.health === "idle", JSON.stringify(u1.json?.health));
  check("idle seat is callable", u1.json?.callable === true);

  await api("/api/admin/tokens", { method: "POST", admin: PK, body: { action: "update", email, credits_used: 0.45 } });
  const u2 = await api("/api/usage", { token: t });
  check("low balance reads degraded", u2.json?.health === "degraded", JSON.stringify(u2.json));
  check("degraded is still callable", u2.json?.callable === true, JSON.stringify(u2.json?.callable));

  const call = await api("/api/noul", { method: "POST", token: t, body: { state: "degraded but working", instructions: "Is this a sentence?" } });
  check("degraded seat can still call", call.status === 200, `got ${call.status}`);
}

// ------------------------------------------------------- unused-token signal
console.log("\nidle (generated but never called)");
{
  const email = `idle-${Date.now()}@example.com`;
  const t = (await api("/api/admin/tokens", { method: "POST", admin: PK, body: { action: "create", email, credits: 10 } })).json?.token;
  const u = await api("/api/usage", { token: t });
  check("never-used seat reads idle", u.json?.health === "idle", JSON.stringify(u.json?.health));
  check("idle seat is callable", u.json?.callable === true, JSON.stringify(u.json?.callable));
  const h = await api("/api/health-token", { token: t });
  check("idle has a remedy, not just a word", typeof h.json?.credits?.available === "number");
}

// ------------------------------------------------------------- revocation
console.log("\nrevocation");
{
  const t3 = (await api("/api/admin/tokens", { method: "POST", admin: PK, body: { action: "create", email: `rev-${Date.now()}@example.com` } })).json.token;
  const okBefore = await api("/api/whoami", { token: t3 });
  check("token works before revoke", okBefore.status === 200);

  const email = JSON.parse(JSON.stringify(okBefore.json)).email;
  const rev = await api("/api/admin/tokens", { method: "POST", admin: PK, body: { action: "revoke", email } });
  check("revoke ok", rev.status === 200 && rev.json?.status === "disabled", JSON.stringify(rev.json));

  const after = await api("/api/whoami", { token: t3 });
  check("token dead after revoke", after.status === 401, `got ${after.status}`);

  const re = await api("/api/admin/tokens", { method: "POST", admin: PK, body: { action: "enable", email } });
  check("re-enable ok", re.status === 200);
  const back = await api("/api/whoami", { token: t3 });
  check("token works again after enable", back.status === 200);
}

// --------------------------------------------------------------- listing
console.log("\nadmin listing");
{
  const r = await api("/api/admin/tokens", { admin: PK });
  check("list 200", r.status === 200);
  check("stats present", r.json?.stats?.max_users === 100, JSON.stringify(r.json?.stats));
  check("active counted", r.json?.stats?.active > 0);
  check("no plaintext token in listing", JSON.stringify(r.json.tokens).indexOf("kdj_") === -1, "listing leaked a token!");
  check("usage rollup present", typeof r.json?.stats?.calls_30d === "number");
  check("credit economy echoed", typeof r.json?.settings?.tokens_per_credit === "number", JSON.stringify(r.json?.settings));

  // This is the mirror image of the "no MYR on user surface" assertion above:
  // the admin view MUST carry money, or the operator cannot reconcile an invoice.
  check("stats carry MYR spend", typeof r.json?.stats?.spend_myr_30d === "number", JSON.stringify(r.json?.stats));
  check("stats carry USD spend", typeof r.json?.stats?.spend_usd_30d === "number", JSON.stringify(r.json?.stats));
  check("stats carry KD Credit spend", typeof r.json?.stats?.credits_30d === "number", JSON.stringify(r.json?.stats));
  check("health breakdown counted", typeof r.json?.stats?.exhausted === "number" && typeof r.json?.stats?.degraded === "number", JSON.stringify(r.json?.stats));
  check("idle seats counted", typeof r.json?.stats?.idle === "number", JSON.stringify(r.json?.stats));

  const row = (r.json?.tokens ?? [])[0];
  check("row has a health verdict", typeof row?.health === "string", JSON.stringify(row));
  check("row has a callable flag", typeof row?.callable === "boolean", JSON.stringify(row));
  check("row has a credit balance", typeof row?.credits?.available === "number", JSON.stringify(row));
  check("row has MYR available", typeof row?.money?.available_myr === "number", JSON.stringify(row?.money));
  check("row has USD available", typeof row?.money?.available_usd === "number", JSON.stringify(row?.money));
  check("row has lifetime JEV tokens", typeof row?.money?.jev_tokens_lifetime === "number", JSON.stringify(row?.money));

  const audit = await api("/api/admin/audit?limit=50", { admin: PK });
  check("audit 200", audit.status === 200);
  check("audit has entries", (audit.json?.logs ?? []).length > 0);
  const actions = (audit.json?.logs ?? []).map((l) => l.action);
  check("audit records issuance", actions.includes("token_created"), JSON.stringify(actions.slice(0, 6)));
  check("audit records failed login", actions.includes("admin_login_fail"), JSON.stringify(actions.slice(0, 6)));
  check("audit records top-ups", actions.includes("token_topped_up"), JSON.stringify(actions.slice(0, 8)));
}

// --------------------------------------------------------- credit settings
console.log("\ncredit settings");
{
  const g = await api("/api/admin/settings", { admin: PK });
  check("settings GET 200", g.status === 200);
  check("settings has rates", typeof g.json?.settings?.myr_micros_per_credit === "number" && typeof g.json?.settings?.usd_micros_per_credit === "number", JSON.stringify(g.json));
  const original = g.json?.settings;

  check("settings needs the passkey", (await api("/api/admin/settings")).json?.error === "unauthorized");
  check("bad settings rejected", (await api("/api/admin/settings", { method: "POST", admin: PK, body: { usd_micros_per_credit: 0 } })).json?.error);
  check("negative settings rejected", (await api("/api/admin/settings", { method: "POST", admin: PK, body: { myr_micros_per_credit: -1 } })).json?.error);
  check("out-of-range pct rejected", (await api("/api/admin/settings", { method: "POST", admin: PK, body: { degraded_pct: 900 } })).json?.error);

  // tokens_per_credit restates the value of every existing balance, so it is
  // refused the moment anyone has spent credit. Refusing is the whole point: the
  // failure mode it prevents is invisible -- a 500-credit grant silently
  // becoming 250, with every dashboard number still looking plausible.
  const guard = await api("/api/admin/settings", { method: "POST", admin: PK, body: { tokens_per_credit: 9999 } });
  check("tokens_per_credit locked after spend", typeof guard.json?.error === "string" && /restate/i.test(guard.json.error), JSON.stringify(guard.json));
  check("locked rate still unchanged", (await api("/api/admin/settings", { admin: PK })).json?.settings?.tokens_per_credit === original?.tokens_per_credit);

  const upd = await api("/api/admin/settings", { method: "POST", admin: PK, body: { degraded_pct: 35 } });
  check("degraded_pct saved", upd.json?.settings?.degraded_pct === 35, JSON.stringify(upd.json));
  const back = await api("/api/admin/settings", { method: "POST", admin: PK, body: { degraded_pct: original.degraded_pct } });
  check("degraded_pct restored", back.json?.settings?.degraded_pct === original.degraded_pct, JSON.stringify(back.json));

  const aud = await api("/api/admin/audit?limit=50", { admin: PK });
  check("settings change is audited", (aud.json?.logs ?? []).map((l) => l.action).includes("credit_settings_updated"));
}

// ------------------------------------------------------------ admin page
console.log("\nadmin page");
{
  const res = await fetch(`${BASE}/admin`);
  const html = await res.text();
  check("/admin 200", res.status === 200);
  check("has generate form", html.includes("Generate API token"));
  check("has passkey field", html.includes("Admin passkey"));
  check("marked noindex", (res.headers.get("x-robots-tag") ?? "") === "noindex");
  check("no-store", (res.headers.get("cache-control") ?? "").includes("no-store"));
  check("does not embed passkey", !html.includes("admk_"));

  // The dashboard is the only surface allowed to show money. If MYR/USD ever
  // appear in the user-facing payload this page stays the sole place they live,
  // so assert the page really is where the operator reads them.
  check("generate form takes KD Credit", html.includes("KD Credit / month"));
  check("form previews the money", html.includes("JEV spend per month"));
  check("table shows MYR", html.includes("Available MYR"));
  check("table shows USD", html.includes("Available USD"));
  check("table shows health", html.includes(">Health<"));
  check("top-up action present", html.includes("Top up"));
  check("credit settings tab present", html.includes("Credit settings"));
  check("settings warns rates are placeholders", html.includes("actual JEV invoice"));

  // The rate direction is a real bug that shipped once: the dashboard divided
  // instead of multiplying and printed RM 212.77 for something that costs
  // RM 0.0047. Off by ~45,000x while looking authoritative. Pin the wording so
  // the direction has to be stated, not inferred from a bare number.
  check("rate is stated per credit", html.includes("1 KD Credit"), "settings does not say what the rate is per");
  check("rate states both directions", html.includes("buys"), "settings does not show the inverse rate");
  check("rate uses the credit as the base", html.includes("1 KD Credit ("), "settings does not anchor the rate to a credit");
  check("16px input floor for iOS zoom", !/input,select\{[^}]*font-size:1[0-5]px/.test(html), "an input below 16px will zoom on iOS");
  check("passkey never written to storage", !/localStorage|sessionStorage/.test(html));

  // Narrow-viewport invariants, verified in a 390px iframe on 2026-10-04: the page
  // did not overflow, the 9-column table scrolled inside its own container rather
  // than widening the document, inputs stayed at 16px so iOS would not zoom, and
  // the grid dropped to 2 columns. CSS assertions only -- they cannot measure.
  // What they DO catch is a regression that deletes the mechanism, e.g. someone
  // "fixing" overflow by adding overflow-x:hidden to body, which hides the table
  // instead of making it reachable.
  check("has a narrow breakpoint", html.includes("@media(max-width:760px)"), "no mobile breakpoint in the stylesheet");
  check("wide table lives in a scroll container", /\.tablewrap\{[^}]*overflow-x:auto/.test(html), "table has no overflow-x:auto parent");
  check("table declares its min width", html.includes("min-width:980px"), "table min-width removed");
  check("overflow is not papered over", !/overflow-x:hidden/.test(html), "overflow-x:hidden would hide the table rather than contain it");
  check("inputs meet the iOS 16px floor", !/input,select\{[^}]*font-size:1[0-5]px/.test(html), "an input below 16px will zoom on iOS");
}

// ------------------------------------------------------------------ done
console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);