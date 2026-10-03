# KD JEV MCP

An authenticated **MCP gateway** to the TypeSafe **JEV / System One** reasoning API, running on
Cloudflare Workers.

Clients hold a `kdj_…` gateway token. The shared JEV API key stays on the server and is injected
per request — a client can never read it, and a leaked gateway token is revocable with one row
update. Behind the gateway sit per-token quota, a per-token burst limiter, and an operator audit log.

```
MCP client ──► /mcp  (Streamable HTTP MCP) ─┐
curl / CI ──► /api/*  (REST mirror)         ├─► D1 quota gate ──► TypeSafe /v1/systemone
operator ───► /admin (token dashboard)      ┘                        (shared JEV_API_KEY)
liveness ───► /health
```

## The three primitives

JEV returns typed decisions instead of prose. The whole product is these three:

| Primitive | Question | Answer |
|---|---|---|
| `choice` | Which option applies? | one of your labels + `probabilities` + `confidence` |
| `noul` | Is this true, and how sure? | `0..1` probability |
| `score` | How much, against a rubric? | index into your levels + `legend` + per-level mass |

Every answer is normalised to one shape, so a client never branches on which primitive produced it:

```json
{ "type": "noul", "value": 0.97, "confidence": null,
  "probabilities": null, "legend": null, "raw": { "...": "upstream verbatim" } }
```

## Tools

| Tool | Purpose |
|---|---|
| `reason` | Many questions of mixed primitives in **one** round trip. The upstream API evaluates them in parallel, so batching is cheaper and faster than repeated single calls. |
| `choice` | One `choice` question. |
| `noul` | One `noul` question. |
| `score` | One `score` question. |
| `usage` | Remaining quota, burst headroom, lifetime JEV token spend. |
| `help` | Self-describing usage notes. |

`reason` is the one to reach for by default. TypeSafe's own guidance is to ask many narrow,
atomic questions and combine the numbers in your own code — a broad question hides several
judgements behind one answer.

## Setup

### 1. Install

```bash
npm install
```

### 2. Secrets

```bash
npx wrangler secret put JEV_API_KEY      # shared TypeSafe JEV key — never exposed to clients
npx wrangler secret put ADMIN_PASSKEY    # gates /admin and /api/admin/*
npx wrangler secret put MCP_TOKEN        # optional break-glass master token, bypasses D1 + quota
```

For local development put the same three in `.dev.vars` (gitignored):

```
JEV_API_KEY=apikey_...
ADMIN_PASSKEY=...
MCP_TOKEN=kdj_...
```

If `JEV_API_KEY` is missing the gateway still starts and `/health` reports `degraded`; tool calls
fail with a 503 that names the missing secret rather than a generic upstream error.

### 3. Database

The `wrangler.jsonc` in this repo ships with an **all-zeros placeholder `database_id`**. It is
deliberately invalid so a forgotten replacement fails loudly at deploy instead of silently binding
someone else's database.

```bash
npx wrangler d1 create kd-jev-mcp
# paste the returned uuid into wrangler.jsonc -> d1_databases[0].database_id
npx wrangler d1 migrations apply kd-jev-mcp --remote
```

Locally:

```bash
npx wrangler d1 migrations apply kd-jev-mcp --local
```

### 4. Deploy

```bash
npm run typecheck
npm run deploy
```

Then open `/admin` and sign in with `ADMIN_PASSKEY`.

## Admin dashboard

`/admin`, gated by `ADMIN_PASSKEY` (constant-time compared, fails closed when unset).

- **Generate API token** — email, label, monthly quota, req/min. Returns the token **once**.
- **Tokens tab** — status, quota bar, burst ceiling, last used. Revoke / enable / edit / rotate.
- **Audit log tab** — every issuance, rotation, revocation and failed admin login, with IP.

The admin passkey is accepted from the `x-admin-passkey` header or the JSON body. It is
deliberately **not** accepted as a query parameter, which would leak it into access logs and browser
history.

### Tokens are stored hashed

A token is generated as `kdj_` + 30 random bytes in base32, and only its SHA-256 hash is stored.
Consequences, all deliberate:

- The dashboard **cannot** re-display a token. Losing it means rotating, which is the point.
- A leaked D1 dump yields no usable credentials.
- Base32 is used so a token survives case-normalising proxies; presentation is folded with
  `normalizeToken` before hashing, so `KDJ_X` and `kdj_x` resolve to the same row.

## Seat cap

`MAX_USERS` (default 100) caps active tokens. The check counts `status = 'active'` rows and runs on
every issuance. Re-issuing or rotating for an **existing** holder does not consume a seat, so
replacing a lost token never trips the limit. Admins can revoke a seat to free it.

## Quota and rate limiting

Two independent limits, both enforced by a **conditional UPDATE** rather than read-then-write:

```sql
UPDATE tokens SET requests_used = requests_used + 1
 WHERE id = ? AND status = 'active' AND requests_used < quota_monthly
```

That matters under concurrency. Two simultaneous requests that both read `requests_used = 999` of a
1000 quota would each allow themselves and overshoot. Putting the predicate in the `WHERE` clause
makes the database the arbiter: the increment succeeds for exactly one of them, or for neither.

The monthly window resets **lazily on first use** after it elapses, so there is no cron to keep
alive and no user is charged for a window that lapsed while idle.

**Quota is charged per tool call, not per HTTP request.** MCP clients send `initialize` and
`tools/list` on nearly every session; charging those would burn a user's allowance without ever
reaching JEV. `usage` is free, so a client can always see its own allowance.

The master `MCP_TOKEN` bypasses the gate entirely. It is the operator's break-glass and is not one
of the metered seats.

## Connecting a client

### As a connector (OAuth 2.1) — recommended

The Worker **is** its own authorization server. There is no external IdP and no
client pre-registration: point any MCP host at the worker and it will discover
the endpoints, register itself, and walk the user through a consent screen.

```
GET  /.well-known/oauth-protected-resource      who protects this resource
GET  /.well-known/oauth-authorization-server    where to authorize
POST /register                                  dynamic client registration (RFC 7591)
GET  /authorize                                 consent screen
POST /token                                     code + refresh grants
POST /revoke                                    RFC 7009 revocation
```

Clients discover the authorization server from the `resource_metadata` challenge
returned by `GET /mcp` when unauthenticated — so handing someone just the `/mcp`
URL is enough for the host to bootstrap. Both the root and path-suffixed
well-known locations are served, because clients differ on which they probe.

Claude Code:

```bash
claude mcp add --transport http kd-jev https://<worker>/mcp
```

ChatGPT and other hosts that follow the MCP OAuth profile work against the same
endpoints with no extra configuration. Identity during consent is the holder's
own `kdj_…` token, so an OAuth grant and a pasted bearer token resolve to the
same quota and usage history.

**Revoking a token kills every OAuth session derived from it** in the same
request. That is deliberate: otherwise revoking a compromised token would leave
live access tokens outstanding for up to an hour, which is the incident rather
than a mitigation of it.

### As a bearer token — for curl, CI, and scripts

```json
{
  "mcpServers": {
    "kd-jev": {
      "type": "http",
      "url": "https://<worker>/mcp",
      "headers": { "authorization": "Bearer kdj_..." }
    }
  }
}
```

`x-api-key: kdj_…` and `?token=kdj_…` are also accepted on the REST routes.

Gateway tokens are hashed **case-folded** (they are lowercase base32, so folding
is lossless), while OAuth access tokens are hashed **verbatim** (they are
base64url, where case is significant). Conflating the two would map distinct
OAuth tokens onto one hash and silently break sessions.

## REST mirror

```bash
curl -sX POST https://<worker>/api/reason \
  -H "authorization: Bearer kdj_..." \
  -H "content-type: application/json" \
  -d '{
    "state": { "ticket": "I was charged twice for order A-104." },
    "questions": {
      "duplicate": { "type": "noul", "instructions": "Does the ticket indicate a duplicate charge?" },
      "topic":      { "type": "choice", "instructions": "What is this about?",
                      "criteria": { "billing": "Charges or refunds", "shipping": "Delivery" } },
      "urgency":    { "type": "score", "instructions": "How urgent is this?",
                      "criteria": ["low", "medium", "high"] }
    }
  }'
```

`/api/choice`, `/api/noul`, `/api/score`, `/api/usage`, `/api/whoami` mirror the tools individually.


## Limits

Enforced in `src/jev.ts` because **JEV bills per question**, so batch size is the spend lever:

| Limit | Value | Why |
|---|---|---|
| Questions per call | 25 | bound worst-case spend per request |
| `state` size | 64,000 chars | bounds input tokens |
| `choice` options | 2–20 | beyond this the options stop being comparable |
| `score` levels | 2–10 | ordered rubric; more becomes a choice in disguise |

## Layout

```
src/
  index.ts    router, MCP server, REST mirror, admin API
  auth.ts     token resolution (master secret, then D1 hash lookup), admin gate
  quota.ts    conditional-UPDATE quota + burst limiter, usage snapshot
  jev.ts      upstream proxy, question validation, answer normalisation
  admin.ts    dashboard (single page, no build step)
  types.ts    Env and shared shapes
  util.ts     hashing, base32 token generation, constant-time compare
migrations/
  0001_init.sql   tokens, usage_events, audit_logs
```

## Security notes

- The JEV API key is read in exactly one place (`src/jev.ts`) and is redacted out of upstream error
  text before it is surfaced, since upstream bodies are forwarded verbatim.
- `resolveCredential` returns `null` for both "no token" and "bad token" — distinguishing them would
  confirm that a guessed token once existed.
- A revoked token stops working on the very next request; there is no cache to wait out.
- The JEV key, admin passkey and master token are **live credentials**. Rotate the JEV key if it has
  travelled anywhere untrusted.