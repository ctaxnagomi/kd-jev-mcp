// Admin dashboard.
//
// Single page, no build step, served from /admin and gated by ADMIN_PASSKEY.
//
// The generated token is displayed exactly once, immediately after creation.
// It is stored only as a SHA-256 hash, so there is no code path anywhere that
// could re-display it later -- that is the point. If it is lost, regenerate.

export const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>KD JEV MCP — Token Admin</title>
<style>
:root{--bg:#0a0a0a;--surface:#16181c;--surface2:#1d2025;--border:#262a30;--accent:#00f0ff;--text:#fff;--muted:#7d8187;--green:#4ade80;--red:#f87171;--amber:#fbbf24}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:var(--bg);font-family:ui-sans-serif,-apple-system,'Segoe UI',Roboto,sans-serif;color:var(--text);-webkit-text-size-adjust:100%}
body{padding:16px;padding-top:max(16px,env(safe-area-inset-top));padding-bottom:max(16px,env(safe-area-inset-bottom))}
.wrap{max-width:1100px;margin:0 auto}
h1{font-size:22px;font-weight:600;letter-spacing:-.02em}
h2{font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:12px}
.sub{color:var(--muted);font-size:13px;margin-top:4px}
input,select{width:100%;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:14px;font-family:inherit;outline:none}
input:focus,select:focus{border-color:var(--accent)}
label{display:block;font-size:11px;color:var(--muted);margin:0 0 5px;text-transform:uppercase;letter-spacing:.06em}
.field{margin-bottom:12px}
.row{display:grid;grid-template-columns:2fr 2fr 1fr 1fr;gap:12px}
.btn{background:var(--accent);color:#000;border:none;border-radius:8px;padding:10px 16px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
.btn:hover{opacity:.88}
.btn.ghost{background:transparent;color:var(--muted);border:1px solid var(--border)}
.btn.danger{background:var(--red);color:#fff}
.btn:disabled{opacity:.4;cursor:not-allowed}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;margin-bottom:16px}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px}
.stat .num{font-size:24px;font-weight:600;font-variant-numeric:tabular-nums}
.stat .lbl{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-top:3px}
.tablewrap{overflow-x:auto;border:1px solid var(--border);border-radius:10px}
table{width:100%;border-collapse:collapse;font-size:12px;min-width:760px}
th{text-align:left;padding:9px 10px;border-bottom:1px solid var(--border);color:var(--muted);font-weight:500;font-size:10px;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap}
td{padding:9px 10px;border-bottom:1px solid var(--border);font-variant-numeric:tabular-nums;white-space:nowrap}
tr:last-child td{border-bottom:none}
td.email{font-weight:500;max-width:190px;overflow:hidden;text-overflow:ellipsis}
.pill{display:inline-block;padding:2px 7px;border-radius:20px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.pill.active{background:rgba(74,222,128,.14);color:var(--green)}
.pill.disabled{background:rgba(248,113,113,.14);color:var(--red)}
.bar{width:70px;height:5px;background:var(--border);border-radius:3px;overflow:hidden;display:inline-block;vertical-align:middle;margin-right:6px}
.bar>i{display:block;height:100%;background:var(--green)}
.bar>i.warn{background:var(--amber)}.bar>i.over{background:var(--red)}
.link{color:var(--accent);cursor:pointer;font-size:11px;text-decoration:none}
.link:hover{text-decoration:underline}
.link.bad{color:var(--red)}.link.dim{color:var(--muted)}
.secret{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;word-break:break-all;background:var(--bg);border:1px solid var(--accent);border-radius:8px;padding:12px;margin:10px 0}
.warn{background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.35);color:var(--amber);border-radius:8px;padding:10px 12px;font-size:12px;margin:10px 0}
.err{background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.35);color:var(--red);border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:12px}
.ok{background:rgba(74,222,128,.1);border:1px solid rgba(74,222,128,.35);color:var(--green);border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:12px}
.hide{display:none!important}
.login{max-width:380px;margin:8vh auto}
.tabs{display:flex;gap:6px;margin-bottom:14px}
.tab{padding:7px 14px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer;font-size:12px;font-family:inherit}
.tab.on{background:var(--surface2);color:var(--text);border-color:var(--accent)}
.topbar{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:18px;flex-wrap:wrap}
@media(max-width:640px){.row{grid-template-columns:1fr 1fr}.stat .num{font-size:20px}body{padding:10px}}
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
      <div class="field"><label>Monthly quota</label><input type="number" id="g-quota" min="1" max="1000000" value="1000"></div>
      <div class="field"><label>Req / minute</label><input type="number" id="g-rate" min="1" max="10000" value="60"></div>
    </div>
    <button class="btn" id="btn-gen">Generate token</button>
    <div class="sub" style="margin-top:8px">Generating for an existing email issues that holder a fresh token and revokes the previous one.</div>
  </div>

  <div class="tabs">
    <button class="tab on" data-tab="tokens">Tokens</button>
    <button class="tab" data-tab="audit">Audit log</button>
  </div>

  <div id="tab-tokens">
    <div class="tablewrap"><table>
      <thead><tr><th>Email</th><th>Label</th><th>Status</th><th>Quota</th><th>Rate</th><th>Last used</th><th>Created</th><th>Actions</th></tr></thead>
      <tbody id="rows"></tbody>
    </table></div>
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
  if (!r.ok && d.error !== "unauthorized") return d;
  if (r.status === 401) { d.error = "unauthorized"; }
  return d;
}

function setTab(name){
  var tabs = document.querySelectorAll(".tab");
  for (var i=0;i<tabs.length;i++) tabs[i].classList.toggle("on", tabs[i].dataset.tab === name);
  $("tab-tokens").classList.toggle("hide", name !== "tokens");
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
  renderStats(d.stats || {});
  renderRows(d.tokens || []);
}

function signedOut(){
  pk = "";
  $("dash").classList.add("hide");
  $("login").classList.remove("hide");
}

function renderStats(s){
  var cards = [
    ["Tokens", s.total || 0],
    ["Active", s.active || 0],
    ["Disabled", s.disabled || 0],
    ["Capacity", (s.max_users || 100)],
    ["Calls (30d)", s.calls_30d || 0],
    ["JEV tokens (30d)", (s.jev_tokens_30d || 0).toLocaleString()]
  ];
  $("stats").innerHTML = cards.map(function(c){
    return '<div class="stat"><div class="num">' + esc(c[1]) + '</div><div class="lbl">' + esc(c[0]) + '</div></div>';
  }).join("");
  $("sub-line").textContent = (s.active || 0) + " of " + (s.max_users || 100) + " seats in use";
}

function renderRows(tokens){
  if(!tokens.length){
    $("rows").innerHTML = '<tr><td colspan="8" style="color:#7d8187;padding:20px;text-align:center">No tokens yet. Generate one above.</td></tr>';
    return;
  }
  $("rows").innerHTML = tokens.map(function(t){
    var pct = t.quota_monthly ? Math.min(100, Math.round(t.requests_used / t.quota_monthly * 100)) : 0;
    var cls = pct >= 90 ? "over" : pct >= 70 ? "warn" : "";
    var disabled = t.status !== "active";
    var actions =
      (disabled
        ? '<span class="link" onclick="act(\\'enable\\',\\'' + esc(t.email) + '\\')">Enable</span>'
        : '<span class="link bad" onclick="act(\\'revoke\\',\\'' + esc(t.email) + '\\')">Revoke</span>')
      + ' <span class="link" onclick="edit(\\'' + esc(t.email) + '\\',' + t.quota_monthly + ',' + t.rate_limit_per_min + ')">Edit</span>'
      + ' <span class="link dim" onclick="rotate(\\'' + esc(t.email) + '\\')">Rotate</span>';
    return '<tr>'
      + '<td class="email" title="' + esc(t.email) + '">' + esc(t.email) + '</td>'
      + '<td style="color:#7d8187">' + esc(t.label || "—") + '</td>'
      + '<td><span class="pill ' + (disabled ? "disabled" : "active") + '">' + esc(t.status) + '</span></td>'
      + '<td><span class="bar"><i class="' + cls + '" style="width:' + pct + '%"></i></span>' + t.requests_used + "/" + t.quota_monthly + '</td>'
      + '<td style="color:#7d8187">' + t.rate_limit_per_min + "/min</td>"
      + '<td style="color:#7d8187">' + esc(ago(t.last_used_at)) + '</td>'
      + '<td style="color:#7d8187;font-size:11px">' + esc(stamp(t.created_at)) + '</td>'
      + '<td>' + actions + '</td>'
      + '</tr>';
  }).join("");
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
  var d = await api("/api/admin/tokens", {
    method: "POST",
    headers: { "x-admin-passkey": pk },
    body: {
      action: "create",
      email: email,
      label: $("g-label").value.trim() || null,
      quota_monthly: parseInt($("g-quota").value, 10),
      rate_limit_per_min: parseInt($("g-rate").value, 10)
    }
  });
  btn.disabled = false;
  if(d.error){ flash(d.error, "err"); return; }
  lastSecret = d.token;
  $("gen-secret").textContent = d.token;
  $("gen-result").classList.remove("hide");
  $("g-email").value = ""; $("g-label").value = "";
  flash("Token generated for " + email, "ok");
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

async function rotate(email){
  if(!confirm("Rotate the token for " + email + "?\\n\\nThe current token stops working immediately and a new one is shown once.")) return;
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

function edit(email, quota, rate){
  var q = prompt("Monthly quota for " + email + ":", quota);
  if(q === null) return;
  var r = prompt("Requests per minute:", rate);
  if(r === null) return;
  api("/api/admin/tokens", {
    method: "POST",
    headers: { "x-admin-passkey": pk },
    body: { action: "update", email: email, quota_monthly: parseInt(q,10), rate_limit_per_min: parseInt(r,10) }
  }).then(function(d){
    if(d.error){ flash(d.error, "err"); return; }
    flash("Updated " + email, "ok");
    refresh();
  });
}

$("btn-login").onclick = login;
$("btn-out").onclick = signedOut;
$("btn-gen").onclick = generate;
$("btn-dismiss").onclick = function(){ $("gen-result").classList.add("hide"); };
$("btn-copy").onclick = function(){
  var t = lastSecret || $("gen-secret").textContent;
  if(navigator.clipboard){ navigator.clipboard.writeText(t); flash("Copied to clipboard", "ok"); }
  else { $("gen-secret").select(); document.execCommand("copy"); flash("Copied", "ok"); }
};
$("pk").addEventListener("keydown", function(e){ if(e.key === "Enter") login(); });
var tabBtns = document.querySelectorAll(".tab");
for(var i=0;i<tabBtns.length;i++){ tabBtns[i].onclick = function(){ setTab(this.dataset.tab); }; }
</script>
</body>
</html>`;