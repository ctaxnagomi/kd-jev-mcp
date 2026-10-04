// Admin dashboard.
//
// Single page, no build step, served from /admin and gated by ADMIN_PASSKEY.
//
// The generated token is displayed exactly once, immediately after creation.
// It is stored only as a SHA-256 hash, so there is no code path anywhere that
// could re-display it later -- that is the point. If it is lost, regenerate.
//
// This surface is the ONLY place MYR and USD appear. The user-facing `usage`
// tool reports KD Credit and nothing else, so the operator can restate exchange
// rates here without any client needing to know.

export const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>KD JEV MCP — Token Admin</title>
<style>
:root{--bg:#0a0a0a;--surface:#16181c;--surface2:#1d2025;--border:#262a30;--accent:#00f0ff;--text:#fff;--muted:#7d8187;--green:#4ade80;--red:#f87171;--amber:#fbbf24;--blue:#60a5fa;--grey:#6b7280}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:var(--bg);font-family:ui-sans-serif,-apple-system,'Segoe UI',Roboto,sans-serif;color:var(--text);-webkit-text-size-adjust:100%}
body{padding:16px;padding-top:max(16px,env(safe-area-inset-top));padding-bottom:max(16px,env(safe-area-inset-bottom))}
.wrap{max-width:1180px;margin:0 auto}
h1{font-size:22px;font-weight:600;letter-spacing:-.02em}
h2{font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:12px}
.sub{color:var(--muted);font-size:13px;margin-top:4px}
input,select{width:100%;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:16px;font-family:inherit;outline:none}
input:focus,select:focus{border-color:var(--accent)}
label{display:block;font-size:11px;color:var(--muted);margin:0 0 5px;text-transform:uppercase;letter-spacing:.06em}
.field{margin-bottom:12px}
.row{display:grid;grid-template-columns:2fr 2fr 1.2fr 1fr 1fr;gap:12px}
.row4{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px}
.btn{background:var(--accent);color:#000;border:none;border-radius:8px;padding:10px 16px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
.btn:hover{opacity:.88}
.btn.ghost{background:transparent;color:var(--muted);border:1px solid var(--border)}
.btn.danger{background:var(--red);color:#fff}
.btn:disabled{opacity:.4;cursor:not-allowed}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:16px}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px}
.stat .num{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.2}
.stat .num.sm{font-size:15px}
.stat .lbl{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-top:3px}
.stat .sub2{font-size:11px;color:var(--grey);margin-top:2px;font-variant-numeric:tabular-nums}
.tablewrap{overflow-x:auto;border:1px solid var(--border);border-radius:10px}
table{width:100%;border-collapse:collapse;font-size:12px;min-width:980px}
th{text-align:left;padding:9px 10px;border-bottom:1px solid var(--border);color:var(--muted);font-weight:500;font-size:10px;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap}
td{padding:9px 10px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums;white-space:nowrap}
tr:last-child td{border-bottom:none}
td.email{font-weight:500;max-width:190px;overflow:hidden;text-overflow:ellipsis}
.pill{display:inline-block;padding:2px 7px;border-radius:20px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.pill.active{background:rgba(74,222,128,.14);color:var(--green)}
.pill.idle{background:rgba(96,165,250,.14);color:var(--blue)}
.pill.degraded{background:rgba(251,191,36,.14);color:var(--amber)}
.pill.exhausted{background:rgba(248,113,113,.14);color:var(--red)}
.pill.revoked{background:rgba(107,114,128,.18);color:var(--grey)}
.bar{width:64px;height:5px;background:var(--border);border-radius:3px;overflow:hidden;display:inline-block;vertical-align:middle;margin-right:6px}
.bar>i{display:block;height:100%;background:var(--green)}
.bar>i.warn{background:var(--amber)}.bar>i.over{background:var(--red)}
.link{color:var(--accent);cursor:pointer;font-size:11px;text-decoration:none}
.link:hover{text-decoration:underline}
.link.bad{color:var(--red)}.link.dim{color:var(--muted)}
.secret{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;word-break:break-all;background:var(--bg);border:1px solid var(--accent);border-radius:8px;padding:12px;margin:10px 0}
.warn{background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.35);color:var(--amber);border-radius:8px;padding:10px 12px;font-size:12px;margin:10px 0}
.err{background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.35);color:var(--red);border-radius:8px;padding:12px 14px;font-size:13px;margin-bottom:12px}
.ok{background:rgba(74,222,128,.1);border:1px solid rgba(74,222,128,.35);color:var(--green);border-radius:8px;padding:12px 14px;font-size:13px;margin-bottom:12px}
.hide{display:none!important}
.login{max-width:380px;margin:8vh auto}
.tabs{display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap}
.tab{padding:7px 14px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer;font-size:12px;font-family:inherit}
.tab.on{background:var(--surface2);color:var(--text);border-color:var(--accent)}
.topbar{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:18px;flex-wrap:wrap}
.preview{font-size:12px;color:var(--muted);margin:-4px 0 12px;font-variant-numeric:tabular-nums}
.preview b{color:var(--accent);font-weight:600}
@media(max-width:760px){.row{grid-template-columns:1fr 1fr}.row4{grid-template-columns:1fr 1fr}.stat .num{font-size:18px}body{padding:10px}}
</style>
</head>
<body>
<div class="wrap">

<div id="login" class="login">
  <div class="card">
    <h1>KD JEV MCP</h1>
    <div class="sub" style="margin-bottom:20px">Token administration</div>
    <div id="login-err" class="err hide"></div>
    <div class="field"><label>Admin passkey</label><input type="password" id="pk" autocomplete="current-password" placeholder="••••••••"></div>
    <button class="btn" id="btn-login" style="width:100%">Sign in</button>
  </div>
</div>

<div id="dash" class="hide">
  <div class="topbar">
    <div><h1>KD JEV MCP</h1><div class="sub" id="sub-line">token administration</div></div>
    <button class="btn ghost" id="btn-out">Sign out</button>
  </div>

  <div id="flash"></div>
  <div class="stats" id="stats"></div>

  <div class="card">
    <h2>Generate API token</h2>
    <div id="gen-result" class="hide">
      <div class="warn">Copy this token now. It is stored only as a SHA-256 hash and cannot be shown again.</div>
      <div class="secret" id="gen-secret">—</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="btn-copy">Copy</button>
        <button class="btn ghost" id="btn-dismiss">I've copied it</button>
      </div>
    </div>
    <div class="row" style="margin-top:12px">
      <div class="field"><label>Email *</label><input type="email" id="g-email" placeholder="user@example.com" required></div>
      <div class="field"><label>Label</label><input type="text" id="g-label" placeholder="Alice (contractor)"></div>
      <div class="field"><label>KD Credit / month</label><input type="number" id="g-credits" min="0" step="any" value="500"></div>
      <div class="field"><label>Req / minute</label><input type="number" id="g-rate" min="1" max="10000" value="60"></div>
      <div class="field"><label>Request cap</label><input type="number" id="g-quota" min="0" step="1" placeholder="none"></div>
    </div>
    <div class="preview" id="g-preview"></div>
    <button class="btn" id="btn-gen">Generate token</button>
    <div class="sub" style="margin-top:8px">
      Generating for an existing email issues that holder a fresh token and keeps their KD Credit grant.
      Request cap is an optional extra ceiling — 0 or blank means the credit balance is the only limit.
    </div>
  </div>

  <div class="tabs">
    <button class="tab on" data-tab="tokens">Tokens</button>
    <button class="tab" data-tab="settings">Credit settings</button>
    <button class="tab" data-tab="audit">Audit log</button>
  </div>

  <div id="tab-tokens">
    <div class="tablewrap"><table>
      <thead><tr><th>Email</th><th>Label</th><th>Health</th><th>KD Credit</th><th>Available MYR</th><th>Available USD</th><th>JEV tokens</th><th>Last used</th><th>Actions</th></tr></thead>
      <tbody id="rows"></tbody>
    </table></div>
  </div>

  <div id="tab-settings" class="hide">
    <div class="card">
      <h2>Credit economy</h2>
      <div class="warn">
        These rates convert KD Credit into money for your own accounting. They are never sent to a
        user-facing endpoint. Set them to reconcile against your actual JEV invoice rather than
        accepting the defaults.
      </div>
      <div id="settings-msg"></div>
      <div class="row4">
        <div class="field"><label>JEV tokens per 1 KD Credit</label><input type="number" id="s-tpc" min="1" step="1"></div>
        <div class="field"><label>MYR micros per credit</label><input type="number" id="s-myr" min="1" step="1"></div>
        <div class="field"><label>USD micros per credit</label><input type="number" id="s-usd" min="1" step="1"></div>
        <div class="field"><label>Degraded below (%)</label><input type="number" id="s-deg" min="0" max="100" step="1"></div>
      </div>
      <div class="row4">
        <div class="field"><label>Default KD Credit for new tokens</label><input type="number" id="s-defc" min="0" step="any"></div>
      </div>
      <button class="btn" id="btn-save-settings">Save settings</button>
      <div class="sub" style="margin-top:8px">1 credit = <span id="s-rates">—</span></div>
    </div>
  </div>

  <div id="tab-audit" class="hide">
    <div class="tablewrap"><table>
      <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Detail</th><th>IP</th></tr></thead>
      <tbody id="arows"></tbody>
    </table></div>
  </div>

</div>
</div>

<script>
var pk = "";
var lastSecret = "";
var SET = { tokens_per_credit: 2000, myr_micros_per_credit: 4700, usd_micros_per_credit: 1000, degraded_pct: 20, default_credits: 500 };

function $(id){ return document.getElementById(id); }
function esc(s){
  return String(s == null ? "" : s).replace(/[&<>"']/g, function(m){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m];
  });
}
function ago(ts){
  if(!ts) return "never";
  var s = Math.floor((Date.now() - ts)/1000);
  if(s < 60) return s + "s ago";
  if(s < 3600) return Math.floor(s/60) + "m ago";
  if(s < 86400) return Math.floor(s/3600) + "h ago";
  return Math.floor(s/86400) + "d ago";
}
function stamp(ts){
  return ts ? new Date(ts).toLocaleString() : "—";
}
function num(n){
  var v = Number(n || 0);
  return v.toLocaleString(undefined, { maximumFractionDigits: 3 });
}
function money(n){
  var v = Number(n || 0);
  return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}
function flash(msg, kind){
  $("flash").innerHTML = '<div class="' + (kind||"ok") + '">' + esc(msg) + '</div>';
  if(kind !== "err") setTimeout(function(){ $("flash").innerHTML = ""; }, 6000);
}

async function api(path, opts){
  opts = opts || {};
  var r = await fetch(path, {
    method: opts.method || "GET",
    headers: Object.assign({ "content-type": "application/json" }, opts.headers || {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  var d = {};
  try { d = await r.json(); } catch(e) { d = { error: "bad response (" + r.status + ")" }; }
  if (r.status === 401) { d.error = "unauthorized"; }
  return d;
}

function setTab(name){
  var tabs = document.querySelectorAll(".tab");
  for (var i=0;i<tabs.length;i++) tabs[i].classList.toggle("on", tabs[i].dataset.tab === name);
  $("tab-tokens").classList.toggle("hide", name !== "tokens");
  $("tab-settings").classList.toggle("hide", name !== "settings");
  $("tab-audit").classList.toggle("hide", name !== "audit");
  if(name === "audit") loadAudit();
}

async function login(){
  pk = $("pk").value;
  if(!pk){ $("login-err").textContent = "Enter the admin passkey"; $("login-err").classList.remove("hide"); return; }
  var d = await api("/api/admin/tokens", { headers: { "x-admin-passkey": pk } });
  if(d.error === "unauthorized"){ $("login-err").textContent = "Wrong passkey"; $("login-err").classList.remove("hide"); return; }
  if(d.error){ $("login-err").textContent = d.error; $("login-err").classList.remove("hide"); return; }
  $("login-err").classList.add("hide");
  $("login").classList.add("hide");
  $("dash").classList.remove("hide");
  $("pk").value = "";
  await refresh();
}

async function refresh(){
  var d = await api("/api/admin/tokens", { headers: { "x-admin-passkey": pk } });
  if(d.error === "unauthorized"){ signedOut(); return; }
  if(d.error){ flash(d.error, "err"); return; }
  if(d.settings) SET = d.settings;
  renderStats(d.stats || {});
  renderRows(d.tokens || []);
  renderSettings();
}

function signedOut(){
  pk = "";
  $("dash").classList.add("hide");
  $("login").classList.remove("hide");
}

function renderStats(s){
  var cards = [
    ["Seats", (s.active || 0) + " / " + (s.max_users || 100), (s.seats_left || 0) + " free"],
    ["Calls (30d)", num(s.calls_30d), ""],
    ["JEV tokens (30d)", num(s.jev_tokens_30d), ""],
    ["KD Credit (30d)", num(s.credits_30d), ""],
    ["Spend MYR (30d)", "RM " + money(s.spend_myr_30d), "your cost"],
    ["Spend USD (30d)", "$" + money(s.spend_usd_30d), "your cost"],
    ["Exhausted", num(s.exhausted), num(s.degraded) + " low · " + num(s.idle) + " unused"]
  ];
  $("stats").innerHTML = cards.map(function(c){
    return '<div class="stat"><div class="num' + (String(c[1]).length > 8 ? " sm" : "") + '">' + esc(c[1])
         + '</div><div class="lbl">' + esc(c[0]) + '</div>'
         + (c[2] ? '<div class="sub2">' + esc(c[2]) + '</div>' : "") + '</div>';
  }).join("");
  $("sub-line").textContent = (s.active || 0) + " of " + (s.max_users || 100) + " seats in use";
}

/**
 * Health drives the colour, not the raw status column. A revoked seat and an
 * exhausted seat are both "cannot call", and showing the operator two different
 * words for the same operational fact is worse than showing one word plus the
 * reason.
 */
function renderRows(tokens){
  if(!tokens.length){
    $("rows").innerHTML = '<tr><td colspan="9" style="color:#7d8187;padding:20px;text-align:center">No tokens yet. Generate one above.</td></tr>';
    return;
  }
  $("rows").innerHTML = tokens.map(function(t){
    var c = t.credits || { granted: 0, used: 0, extra: 0, available: 0 };
    var total = (c.granted || 0) + (c.extra || 0);
    var pct = total > 0 ? Math.max(0, Math.min(100, Math.round(c.available / total * 100))) : 0;
    var cls = c.available <= 0 ? "over" : pct <= 20 ? "warn" : "";
    var h = t.health || "active";
    var m = t.money || {};
    var revoked = h === "revoked";
    var actions =
      (revoked
        ? '<span class="link" onclick="act(\\'enable\\',\\'' + esc(t.email) + '\\')">Enable</span>'
        : '<span class="link bad" onclick="act(\\'revoke\\',\\'' + esc(t.email) + '\\')">Revoke</span>')
      + ' <span class="link" onclick="topup(\\'' + esc(t.email) + '\\')">Top up</span>'
      + ' <span class="link" onclick="edit(\\'' + esc(t.email) + '\\',' + (c.granted||0) + ',' + t.rate_limit_per_min + ')">Edit</span>'
      + ' <span class="link dim" onclick="rotate(\\'' + esc(t.email) + '\\')">Rotate</span>';
    return '<tr>'
      + '<td class="email" title="' + esc(t.email) + '">' + esc(t.email) + '</td>'
      + '<td style="color:#7d8187">' + esc(t.label || "—") + '</td>'
      + '<td><span class="pill ' + esc(h) + '">' + esc(h) + '</span></td>'
      + '<td><span class="bar"><i class="' + cls + '" style="width:' + pct + '%"></i></span>'
      + num(c.available) + ' <span style="color:#6b7280">/ ' + num(total) + '</span></td>'
      + '<td style="color:#a1a1a6">RM ' + money(m.available_myr) + '</td>'
      + '<td style="color:#a1a1a6">$' + money(m.available_usd) + '</td>'
      + '<td style="color:#7d8187">' + num(m.jev_tokens_lifetime) + '</td>'
      + '<td style="color:#7d8187">' + esc(ago(t.last_used_at)) + '</td>'
      + '<td>' + actions + '</td>'
      + '</tr>';
  }).join("");
}

function renderSettings(){
  $("s-tpc").value  = SET.tokens_per_credit;
  $("s-myr").value  = SET.myr_micros_per_credit;
  $("s-usd").value  = SET.usd_micros_per_credit;
  $("s-deg").value  = SET.degraded_pct;
  $("s-defc").value = SET.default_credits;

  // Money PER CREDIT, which is what the micros-per-credit fields actually store:
  // micros are 1e-6 of a unit, so RM 0.0047 is stored as 4700.
  var myrPerCredit = (SET.myr_micros_per_credit || 0) / 1000000;
  var usdPerCredit = (SET.usd_micros_per_credit || 0) / 1000000;

  // Both directions, each labelled. An earlier version printed
  // 1000000 / myr_micros_per_credit next to a "RM" label, which is CREDITS per RM,
  // not RM per credit -- so it claimed 2,000 JEV tokens cost RM 212.77 when they
  // cost RM 0.0047. An inverted rate under a currency symbol is worse than no
  // rate at all: it is off by a factor of ~45,000 and still looks authoritative.
  var creditsPerMyr = myrPerCredit > 0 ? 1 / myrPerCredit : 0;
  var creditsPerUsd = usdPerCredit > 0 ? 1 / usdPerCredit : 0;

  $("s-rates").textContent =
    "1 KD Credit (" + num(SET.tokens_per_credit) + " JEV tokens) = RM " + money(myrPerCredit)
    + " = $" + money(usdPerCredit)
    + "  ·  RM 1 buys " + num(creditsPerMyr) + " credit, $1 buys " + num(creditsPerUsd);
}

/** Live conversion preview on the generate form, so the operator sees the money. */
function updatePreview(){
  var credits = parseFloat($("g-credits").value);
  if(!isFinite(credits) || credits <= 0){ $("g-preview").innerHTML = ""; return; }
  var tpc = SET.tokens_per_credit || 2000;
  var jev = credits * tpc;
  var myr = credits * (SET.myr_micros_per_credit / 1000000);
  var usd = credits * (SET.usd_micros_per_credit / 1000000);
  $("g-preview").innerHTML =
    "≈ <b>" + num(jev) + "</b> JEV tokens · ≈ <b>RM " + money(myr) + "</b> · ≈ <b>$" + money(usd) + "</b> of JEV spend per month";
}

async function saveSettings(){
  $("settings-msg").innerHTML = "";
  var d = await api("/api/admin/settings", {
    method: "POST",
    headers: { "x-admin-passkey": pk },
    body: {
      tokens_per_credit: parseInt($("s-tpc").value, 10),
      myr_micros_per_credit: parseInt($("s-myr").value, 10),
      usd_micros_per_credit: parseInt($("s-usd").value, 10),
      degraded_pct: parseInt($("s-deg").value, 10),
      default_credits: parseFloat($("s-defc").value)
    }
  });
  if(d.error){ $("settings-msg").innerHTML = '<div class="err">' + esc(d.error) + '</div>'; return; }
  SET = d.settings || SET;
  renderSettings();
  updatePreview();
  $("settings-msg").innerHTML = '<div class="ok">Saved.</div>';
  await refresh();
}

async function loadAudit(){
  var d = await api("/api/admin/audit?limit=100", { headers: { "x-admin-passkey": pk } });
  if(d.error === "unauthorized"){ signedOut(); return; }
  if(d.error){ flash(d.error, "err"); return; }
  var logs = d.logs || [];
  $("arows").innerHTML = logs.length ? logs.map(function(l){
    return '<tr>'
      + '<td style="color:#7d8187;font-size:11px">' + esc(stamp(l.created_at)) + '</td>'
      + '<td>' + esc(l.actor) + '</td>'
      + '<td>' + esc(l.action) + '</td>'
      + '<td style="color:#7d8187">' + esc(l.detail || "") + '</td>'
      + '<td style="color:#7d8187;font-size:11px">' + esc(l.ip || "") + '</td>'
      + '</tr>';
  }).join("") : '<tr><td colspan="5" style="color:#7d8187;padding:20px;text-align:center">No audit entries.</td></tr>';
}

async function generate(){
  var email = $("g-email").value.trim().toLowerCase();
  if(!email || email.indexOf("@") < 1){ flash("Enter a valid email address", "err"); return; }
  var btn = $("btn-gen");
  btn.disabled = true;
  var body = {
    action: "create",
    email: email,
    label: $("g-label").value.trim() || null,
    credits: parseFloat($("g-credits").value),
    quota_monthly: parseInt($("g-quota").value, 10) || 0,
    rate_limit_per_min: parseInt($("g-rate").value, 10)
  };
  var d = await api("/api/admin/tokens", { method: "POST", headers: { "x-admin-passkey": pk }, body: body });
  btn.disabled = false;
  if(d.error){ flash(d.error, "err"); return; }
  lastSecret = d.token;
  $("gen-secret").textContent = d.token;
  $("gen-result").classList.remove("hide");
  $("g-email").value = ""; $("g-label").value = "";
  flash("Token generated for " + email + " · " + num(d.credits) + " KD Credit (RM "
        + money(d.money && d.money.granted_myr) + ")", "ok");
  await refresh();
}

async function act(action, email){
  if(action === "revoke" && !confirm("Revoke the token for " + email + "? They lose access immediately.")) return;
  var d = await api("/api/admin/tokens", {
    method: "POST",
    headers: { "x-admin-passkey": pk },
    body: { action: action, email: email }
  });
  if(d.error){ flash(d.error, "err"); return; }
  flash((action === "revoke" ? "Revoked " : "Enabled ") + email, "ok");
  await refresh();
}

/**
 * Top-up adds to credits_extra, not to the grant, so it survives the next
 * monthly reset. The prompt says so explicitly because an operator who assumed
 * otherwise would eventually be surprised.
 */
async function topup(email){
  var v = prompt("Add KD Credit to " + email + " (permanent, survives the monthly reset):", "100");
  if(v === null) return;
  var credits = parseFloat(v);
  if(!isFinite(credits) || credits <= 0){ flash("Enter a positive amount", "err"); return; }
  var myr = credits * (SET.myr_micros_per_credit / 1000000);
  var d = await api("/api/admin/tokens", {
    method: "POST",
    headers: { "x-admin-passkey": pk },
    body: { action: "topup", email: email, credits: credits }
  });
  if(d.error){ flash(d.error, "err"); return; }
  flash("Added " + num(d.added) + " KD Credit (RM " + money(myr) + ") to " + email, "ok");
  await refresh();
}

async function rotate(email){
  if(!confirm("Rotate the token for " + email + "?\\n\\nThe current token stops working immediately and a new one is shown once. Their KD Credit grant is kept.")) return;
  var d = await api("/api/admin/tokens", {
    method: "POST",
    headers: { "x-admin-passkey": pk },
    body: { action: "rotate", email: email }
  });
  if(d.error){ flash(d.error, "err"); return; }
  lastSecret = d.token;
  $("gen-secret").textContent = d.token;
  $("gen-result").classList.remove("hide");
  flash("Rotated " + email, "ok");
  await refresh();
}

function edit(email, granted, rate){
  var c = prompt("Monthly KD Credit grant for " + email + " (currently " + granted + "):", granted);
  if(c === null) return;
  var g = parseFloat(c);
  if(!isFinite(g) || g < 0){ flash("Enter a non-negative amount", "err"); return; }
  var r = prompt("Requests per minute:", rate);
  if(r === null) return;
  api("/api/admin/tokens", {
    method: "POST",
    headers: { "x-admin-passkey": pk },
    body: { action: "update", email: email, credits_granted: g, rate_limit_per_min: parseInt(r,10) }
  }).then(function(d){
    if(d.error){ flash(d.error, "err"); return; }
    flash("Updated " + email, "ok");
    refresh();
  });
}

$("btn-login").onclick = login;
$("btn-out").onclick = signedOut;
$("btn-gen").onclick = generate;
$("btn-save-settings").onclick = saveSettings;
$("g-credits").addEventListener("input", updatePreview);
$("btn-dismiss").onclick = function(){ $("gen-result").classList.add("hide"); };
$("btn-copy").onclick = function(){
  var t = lastSecret || $("gen-secret").textContent;
  if(navigator.clipboard){ navigator.clipboard.writeText(t); flash("Copied to clipboard", "ok"); }
  else { flash("Copy failed — select and copy manually", "err"); }
};
$("pk").addEventListener("keydown", function(e){ if(e.key === "Enter") login(); });
var tabBtns = document.querySelectorAll(".tab");
for(var i=0;i<tabBtns.length;i++){ tabBtns[i].onclick = function(){ setTab(this.dataset.tab); }; }
// Paint the money preview on load, not only on the first keystroke. The rates are
// already known from the initial /api/admin/tokens response, so there is no reason
// to make the operator type before they can see what the grant costs.
updatePreview();
</script>
</body>
</html>`;