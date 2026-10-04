# KD JEV MCP

An authenticated **MCP gateway** to the TypeSafe **JEV / System One** reasoning API, running on
Cloudflare Workers.

Clients hold a `kdj_…` gateway token. The shared JEV API key stays on the server and is injected
per request — a client can never read it, and a leaked gateway token is revocable with one row
update. Behind the gateway sit a **KD Credit balance**, a per-token burst limiter, and an operator
audit log.

The service is **free to users**. Credits are the internal unit: users see a balance, never a price,
and the operator converts it to MYR or USD to reconcile against the JEV invoice. See
[KD Credit](#kd-credit--the-balance).

```
MCP client ──► /mcp  (Streamable HTTP MCP) ─┐
curl / CI ──► /api/*  (REST mirror)         ├─► D1 credit gate ──► TypeSafe /v1/systemone
operator ───► /admin (token dashboard)      ┘                        (shared JEV_API_KEY)
liveness ───► /health
```

> **Licensing status — read before operating this for others.**
> TypeSafe's [Interface terms](https://typesafe.ai/terms) grant API access
> "solely for the purpose of evaluating", forbid sharing access credentials
> with third parties, and forbid using the interfaces "to provide any product
> or service to a third party". Running this gateway as a multi-tenant service
> therefore needs TypeSafe's permission, which has been requested and not yet
> granted. Self-hosting it for your own team or invited collaborators is within
> the terms as written. See [`docs/TYPESAFE-PERMISSION-REQUEST.md`](docs/TYPESAFE-PERMISSION-REQUEST.md).

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
| `usage` | KD Credit balance, operational health, burst headroom, call counts. |
| `token_health` | One-word verdict — `active` / `idle` / `degraded` / `exhausted` / `revoked` — with the remedy. |
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
npx wrangler secret put MCP_TOKEN        # optional break-glass master token, bypasses D1 metering
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

## Tests

Both suites run against a live `wrangler dev` on `127.0.0.1:8787` and need the
secrets from `.dev.vars` in the environment.

```bash
npm run dev          # in one shell
npm run typecheck
npm run smoke        # data plane: tokens, credits, JEV primitives, MCP protocol
npm run oauth        # authorization plane: DCR, consent, PKCE, refresh, revoke
```

`npm run smoke` covers the gateway: token issuance and rotation, all three JEV
primitives against the live API, the MCP handshake, rate limiting, the credit
lifecycle (grant → debit → exhaustion → top-up → resume), health states, the
absence of any price on the user surface, revocation, and the admin surfaces.

`npm run oauth` covers the OAuth 2.1 authorization plane a MCP host walks at
connect time: the RFC 9728 / RFC 8414 discovery documents, the RFC 9724 401
challenge, dynamic client registration, consent, the PKCE S256 exchange,
single-use authorization codes, refresh rotation, revocation, and the cascade
where revoking a gateway token kills the OAuth sessions derived from it.

## Admin dashboard

`/admin`, gated by `ADMIN_PASSKEY` (constant-time compared, fails closed when unset).

- **Generate API token** — email, label, **KD Credit grant**, req/min, and an optional request cap.
  Returns the token **once**.
- **Tokens tab** — health pill, credit bar, available **MYR** and **USD**, lifetime JEV tokens, last
  used. Revoke / enable / top up / edit / rotate.
- **Credit settings tab** — the KD Credit → MYR / USD conversion rates, editable without a redeploy.
- **Audit log tab** — every issuance, rotation, revocation, top-up and failed admin login, with IP.

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

## KD Credit — the balance

The service is free to its users. It is not free to operate: TypeSafe bills on input and output
tokens, so *"what has this seat cost me"* has a real answer that someone needs to see.

**KD Credit** is the unit that answers both questions. A seat is granted an amount of it, JEV calls
debit it by their real token usage, and the operator reads the balance as MYR or USD. Users see only
the credit figure.

```
granted  500 KD Credit
  spent  0.146   (one call, 292 JEV tokens)
  left   499.854
         ≈ RM 2.35   ≈ $0.50
```

### Two surfaces, two currencies

| | user (`usage`, `/api/usage`) | admin (`/admin`, `/api/admin/*`) |
|---|---|---|
| KD Credit | yes | yes |
| MYR / USD | **never** | yes |
| JEV token total | no | yes |

The split is load-bearing, not cosmetic. Since the user surface never states a price or a rate, the
exchange rate can be restated from the dashboard without any client needing to know. A smoke test
asserts `myr`, `usd` and `micros` are absent from the user payload — the rule would otherwise rot
the first time someone helpfully added a column.

### Debit happens *after* the call, not before

A call's cost is not knowable until upstream reports its token usage. So the flow is:

1. **Pre-flight** — is `available > 0`? Refuse with `429 credit_exhausted` if not.
2. **Call** JEV.
3. **Debit** the actual cost, with the balance allowed to go negative.

The negative case is intentional. A seat with 0.3 credit left may start a call that costs more than
that. Clamping the debit to zero would be a tidy lie: the ledger would stop reconciling against the
upstream invoice, and the overspend would vanish precisely when it mattered. The real cost is
recorded, and the *next* call is the one that gets blocked — which is where the user actually needs
to stop. One call's worth of overshoot is the entire exposure.

The debit is **not** a conditional UPDATE, unlike the request counter. By the time the cost is known
it has already been paid upstream; refusing to record it would not save the money.

### Why micro-credits

Credits are stored as integers in **micro**-credits (1 KD Credit = 1,000,000). A typical call costs a
*fraction* of a credit, so rounding each debit to a whole credit would overstate real spend by up to
100% on small calls and would never reconcile against the invoice. Micro precision puts the rounding
error at ~1e-6 of a credit per call.

Debits round **up**, always. Rounding down would systematically undercharge, and the shortfall would
accumulate in the operator's favour without ever surfacing as an error.

### Two kinds of credit, deliberately separate

| Column | Resets monthly? | Set by |
|---|---|---|
| `credits_granted` | yes, lazily with the window | generate form, or edited |
| `credits_extra` | **never** | top-up only |
| `credits_used` | yes | debited per call |

A top-up that vanished at the next reset is how operators stop trusting a balance, so top-ups go to
`credits_extra` and are never reset. The dashboard says so at the prompt.

The window rolls forward **lazily on first use**, so there is no cron to keep alive and no seat is
charged for a window that lapsed while idle.

### Health

`token_health` reports one word, ordered deliberately:

| State | Meaning |
|---|---|
| `revoked` | Revoked. Checked **first** — a revoked seat with credits left is still revoked. |
| `exhausted` | Balance at or below zero. Cannot call. |
| `degraded` | Under `degraded_pct` (default 20%) of its allowance. **Still callable.** |
| `idle` | Has allowance, never used — possibly a broken integration. |
| `active` | Healthy. |

`degraded` does not block. Refusing a call because someone is 3% short would be hostile and would not
save meaningful money. `idle` is separate from `active` because those need different operator
responses: one may be a broken integration, the other is simply working.

Each state carries a `remedy` string. A verdict without a remedy makes the caller guess between
"wait", "pay", and "ask someone".

### Reconfiguring the economy

Rates live in D1 (`credit_settings`), not `wrangler.jsonc`, so exchange rates can be restated from the
dashboard without a redeploy.

`tokens_per_credit` is **refused** once any seat has spent credit. Changing it would silently
restate the value of every existing balance — a 500-credit grant would quietly become 250, with every
number still looking plausible. Making that easy would be making a data-integrity bug easy.

**The shipped rates are placeholders.** Set them to reconcile against your own JEV invoice.

## Rate limiting

A per-token burst ceiling, enforced by a **conditional UPDATE** rather than read-then-write:

```sql
UPDATE tokens SET rate_count = rate_count + 1
 WHERE id = ? AND rate_window = ? AND rate_count < rate_limit_per_min
RETURNING rate_count
```

That matters under concurrency. Two simultaneous requests that both read `rate_count = 59` of a
60/min limit would each allow themselves and overshoot. Putting the predicate in the `WHERE` clause
makes the database the arbiter: the increment succeeds for exactly one of them, or for neither.

There are two controls, and they do different jobs:

- **Rate limit** — caps the instantaneous burst.
- **Credit balance** — caps total spend.

A third limit on request count is available (`quota_monthly`) as an optional blast-radius guard, and
defaults to **0 = off**. Three overlapping spend limits only obscure which one bit.

**Credits are charged per tool call, not per HTTP request.** MCP clients send `initialize` and
`tools/list` on nearly every session; charging those would burn a seat's allowance without ever
reaching JEV. `usage` and `token_health` are free, so a client can always see its own position.

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
same KD Credit balance and usage history.

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

`/api/choice`, `/api/noul`, `/api/score`, `/api/usage`, `/api/health-token`, `/api/whoami` mirror the
tools individually.


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
  oauth.ts    OAuth 2.1 authorization server (DCR, PKCE, consent, revocation)
  auth.ts     credential resolution (master secret → OAuth grant → token hash), admin gate
  quota.ts    credit pre-flight gate, conditional-UPDATE burst limiter, usage snapshot
  credits.ts  KD Credit arithmetic, micro-credit scale, health states, debit + ledger
  jev.ts      upstream proxy, question validation, answer normalisation
  admin.ts    dashboard (single page, no build step)
  types.ts    Env and shared shapes
  util.ts     hashing, base32 token generation, constant-time compare
migrations/
  0001_init.sql       tokens, usage_events, audit_logs
  0002_oauth.sql      oauth_clients, oauth_grants, oauth_access_tokens
  0003_credits.sql    credit_settings, credit balances, credit_ledger
docs/
  AGENT-CATALOGUE.md     configurations A–C: orchestrator, planner, swarm, research,
                         tool orchestrator, policy gate, dual expert — with SWOT + SPACE
  AGENT-ROLES.md         roles D1–D12: debugger through tax filing to the tools router
  FABRICATOR-INTAKE.md   the /Fabri-Jev first-run interview and agent proposal
  TYPESAFE-PERMISSION-REQUEST.md   the licensing ask that unblocks monetisation
scripts/
  smoke.mjs    73 assertions, end-to-end
  oauth.mjs    99 assertions, OAuth 2.1 conformance
```

## Design docs

The gateway is deliberately *thin* — it proxies decisions and does not generate
text. Everything built on top of it therefore has one invariant:

> **The LLM generates. JEV decides.**

JEV returns typed decisions with calibrated confidence. It never writes prose,
code, or plans. So every agent is specified as a pair: what the model is
accountable for, and which of JEV's four roles it is wired into — **router**,
**gate**, **arbiter**, or **verifier**.

| Document | What it holds |
|---|---|
| [`docs/AGENT-CATALOGUE.md`](docs/AGENT-CATALOGUE.md) | Configurations **A** (orchestrator + execution layer), **B** (planner + swarm), **C** (research, tool orchestrator, policy gate, dual expert). Each with concrete question payloads, search/scrape behaviour, permissions, SWOT, and a SPACE matrix resolving to explicit decisions. |
| [`docs/AGENT-ROLES.md`](docs/AGENT-ROLES.md) | The twelve role agents **D1–D12** in the same shape, plus a progressive-enablement order ranked by risk retired per unit of capability, and ten cross-cutting rules. |
| [`docs/FABRICATOR-INTAKE.md`](docs/FABRICATOR-INTAKE.md) | The `/Fabri-Jev` interview: a four-round design tree with a recommended answer per question, four JEV gates inside the intake itself, the DDL for agents and proposals, and the checkmarked proposal table. |
| [`docs/TYPESAFE-PERMISSION-REQUEST.md`](docs/TYPESAFE-PERMISSION-REQUEST.md) | The three Interface-terms clauses that block multi-tenant operation, the mitigations for each, and six answerable questions. |

Two things worth reading before building on these:

- **The `tier` field.** Every agent is `local` (your workspace, your token) or
  `hosted` (shared multi-tenant). `local` is within the Interface terms as
  written. `hosted` is not, and the Fabricator **refuses to create** hosted
  agents until the permission request is answered.
- **SPACE ratings are design aids, not validation.** They are a way of forcing
  the trade-offs into the open and recording the resulting decisions. They are
  not measured data, and nothing in the system should treat them as such.

## Security notes

- The JEV API key is read in exactly one place (`src/jev.ts`) and is redacted out of upstream error
  text before it is surfaced, since upstream bodies are forwarded verbatim.
- `resolveCredential` returns `null` for both "no token" and "bad token" — distinguishing them would
  confirm that a guessed token once existed.
- A revoked token stops working on the very next request; there is no cache to wait out.
- The JEV key, admin passkey and master token are **live credentials**. Rotate the JEV key if it has
  travelled anywhere untrusted.