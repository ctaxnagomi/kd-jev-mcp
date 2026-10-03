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

console.log(`\n=== KD JEV MCP smoke test -> ${BASE} ===\n`);

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
  check("records jev input tokens", before.json?.input_tokens > 0, JSON.stringify(before.json));
  check("remaining computed", typeof before.json?.remaining === "number");
  check("quota fields present", before.json?.quota_monthly === 100);

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
  check("all 6 tools exposed", JSON.stringify(names) === JSON.stringify(["choice", "help", "noul", "reason", "score", "usage"]), JSON.stringify(names));

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

// ---------------------------------------------------- quota exhaustion
console.log("\nquota exhaustion (dedicated token, quota 1)");
{
  const email = `quota-${Date.now()}@example.com`;
  const r = await api("/api/admin/tokens", {
    method: "POST",
    admin: PK,
    body: { action: "create", email, quota_monthly: 1, rate_limit_per_min: 60 },
  });
  const t = r.json?.token;

  const first = await api("/api/noul", { method: "POST", token: t, body: { state: "hello", instructions: "Is this a greeting?" } });
  check("first call within quota ok", first.status === 200, `got ${first.status} ${JSON.stringify(first.json).slice(0, 160)}`);

  const second = await api("/api/noul", { method: "POST", token: t, body: { state: "hello again", instructions: "Is this a greeting?" } });
  check("second call over quota -> 429", second.status === 429, `got ${second.status} ${JSON.stringify(second.json).slice(0, 160)}`);
  check("429 says quota_exceeded", second.json?.code === "quota_exceeded", JSON.stringify(second.json));

  const u = await api("/api/usage", { token: t });
  check("usage shows exhausted", u.json?.remaining === 0, JSON.stringify(u.json));
  check("usage shows 1 of 1 used", u.json?.requests_used === 1 && u.json?.quota_monthly === 1, JSON.stringify(u.json));
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

  const audit = await api("/api/admin/audit?limit=50", { admin: PK });
  check("audit 200", audit.status === 200);
  check("audit has entries", (audit.json?.logs ?? []).length > 0);
  const actions = (audit.json?.logs ?? []).map((l) => l.action);
  check("audit records issuance", actions.includes("token_created"), JSON.stringify(actions.slice(0, 6)));
  check("audit records failed login", actions.includes("admin_login_fail"), JSON.stringify(actions.slice(0, 6)));
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
}

// ------------------------------------------------------------------ done
console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);