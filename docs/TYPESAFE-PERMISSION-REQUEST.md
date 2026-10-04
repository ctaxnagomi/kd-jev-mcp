# TypeSafe AI — request for multi-tenant gateway permission

**Status:** draft, not yet sent.
**Owner:** KrackedDevs (`kd-jev-mcp`)
**Blocking:** operation for **any** third-party user, free or paid. See §7.

---

## 1. Who we are

KrackedDevs is a small team building **KD JEV MCP**, an open-source MCP (Model
Context Protocol) gateway for the Jev System One model. It is published at
`github.com/ctaxnagomi/kd-jev-mcp` (MIT).

The project has three parts:

1. **A token gateway.** It holds a single TypeSafe API key as a server-side
   secret and issues per-user `kdj_…` tokens. Each user gets their own spend
   balance (denominated in an internal "KD Credit" unit and debited by the real
   input/output token usage of each call) and a per-minute rate limit, enforced
   in Cloudflare D1.
2. **An OAuth 2.1 authorization server**, so MCP hosts (Claude Code, ChatGPT,
   Cursor, and anything else speaking the MCP OAuth profile) can add the server
   as a connector with a browser consent flow and PKCE, with no pasted token.
3. **A metering and audit plane.** Every call is attributed to a token, and cost
   is charged per tool call rather than per HTTP request, because MCP clients
   send `initialize` and `tools/list` continuously and per-request billing would
   charge users for protocol chatter.

The gateway is deliberately **not** a memory store and **not** a general LLM
proxy. It exposes exactly the three Jev primitives — `choice`, `noul`, `score` —
plus batched `reason`, and the local-only `usage` / `token_health` / `help`
introspection tools, and forwards the primitives to `POST /v1/systemone`
unchanged. It adds authentication, metering and authorisation. It does not
transform, rank, or repackage your output.

The credit balance is metered against **your** reported token usage, not against
an estimate. That means our cost accounting for any given user reconciles
directly with your invoice, and the gateway cannot be used to spend more than the
tokens a user actually consumes.

Current scale: capped at **100 users**, one D1 database, one Worker.

## 2. What we need

Written permission — or an enterprise/reseller agreement — to operate
KD JEV MCP as a **multi-tenant gateway**, meaning:

- one TypeSafe API key held server-side by us;
- N end users, each holding a `kdj_…` token issued by us;
- every call forwarded on that user's behalf, attributed to them, metered
  against their own credit balance, and logged.

We are not asking to resell raw API access or to broker unrestricted use. Our
users get our gateway's rate limiting, cost accounting, audit trail and OAuth
consent flow — not a pipe to your API.

**No charge to end users.** The service is free to its users and is not
commercialised. A user's balance is a cost ceiling we set for ourselves out of
our own TypeSafe spend, not a tariff we charge them.

## 3. The clauses we believe this touches

From the Interface/API terms at <https://typesafe.ai/terms>:

> User may access and use the APIs "solely for the purpose of evaluating" them.

> User "may not share its access credentials … with any third party", or
> "enable any person other than User's employees or contractors … to access the
> Interfaces."

> User will not "(i) use the Interfaces on behalf of, or to provide any product
> or service to, a third party".

We read each of these as applying to a multi-tenant gateway:

| Our behaviour | Clause | Our reading |
|---|---|---|
| One shared key, many end-user tokens | "may not share its access credentials with any third party" | Prohibited as written |
| Users consume credits we meter against your reported usage | "provide any product or service to a third party" | Prohibited as written |
| Free service funded by our own subscription | "solely for the purpose of evaluating" | Ambiguous — "evaluating" may not extend to operating infrastructure for others, even at no charge |

The third row is the one we are least sure about, and it is worth separating from
the commercial question. We read "evaluating" as covering trying the interfaces
out, not standing up a service that third parties depend on. That the service
charges its users nothing does not obviously change which clause applies, so we
are not treating "free" as a way around this — we are asking.

We would rather have this confirmed than have you find out later, which is why we
are asking before launch rather than after.

## 4. Mitigations already implemented

These are live in the codebase, not aspirational:

- **Per-user spend balance and rate limiting**, enforced in D1. Spend is capped
  by a balance debited by the actual input/output token usage *you* report back
  to us on each call, with an independent per-token minute-bucket burst limiter
  (`UPDATE … WHERE rate_count < rate_limit_per_min RETURNING rate_count`, so
  the database arbitrates the last slot under concurrency). A runaway or abusive
  token cannot exceed its ceiling, so it cannot exhaust your capacity on your
  behalf.
- **Hard user cap** of 100, enforced server-side.
- **No plaintext credential storage.** Only a SHA-256 hash of each token is
  stored; the token is displayed once at issuance. Your API key is a Worker
  secret and is never returned to any client, logged, or persisted.
- **Full audit trail**: every issuance, rotation, revocation, top-up, and failed
  authentication is recorded with timestamp and IP. Spend is additionally kept in
  a per-call ledger recording the token count each call consumed.
- **Immediate revocation.** Revoking a user's token kills every live OAuth
  session derived from it on the next request, and burns any pending
  authorization codes.
- **No content retention.** We store no prompts, states, or answers. Only
  aggregate token counts per user, and the per-call cost ledger.
- **Attribution** back to you, in our README and dashboard.

## 5. A second, smaller question — the documentation licence

`ctaxnagomi/INSTRUCT_JEV` is a dataset we compiled from your public
documentation at <https://docs.typesafe.ai>, released under MIT on Hugging Face.

Our dataset card states that "upstream TypeSafe AI documentation is
MIT-licensed". That claim came from your docs. However, the Site Terms at
<https://typesafe.ai/terms> state that all Materials in the Site are the property
of TypeSafe AI and may not be reproduced or distributed except as authorised.

These two statements appear to conflict, and we would like to resolve it:

1. **Is the text of `docs.typesafe.ai` MIT-licensed for redistribution?** If
   yes, we will keep the dataset and add fuller attribution. If no, we will
   take the dataset down and replace it with an index of links plus
   independently written descriptions of the primitives.
2. If redistribution is not permitted, do you instead offer a **permitted
   internal-use corpus** for fine-tuning Jev usage? We would prefer to license
   it from you than to guess.

We are not using the dataset to train a competing model, and we read the
prohibition on "model distillation / train a model to imitate the output" as
applying to model weights rather than to an instructional reference — but we
would like that confirmed rather than assumed.

## 6. Questions we would like answered

1. Does the Interface Terms grant permit operating a **multi-tenant gateway**
   that authenticates and meters end users against a single key, where the
   gateway adds authentication, metering and audit rather than reselling raw
   access?
2. If not, is there an **enterprise, reseller, or OEM agreement** that would
   cover it? We are willing to sign and to disclose our users. Note that we are
   **not** currently charging end users, so a per-seat commercial commitment is
   not something we can offer today — see §7.
3. If multi-tenancy is possible at all, what **per-seat or aggregate rate
   limits** do you require, and do you offer a **higher or reserved-capacity
   tier** for a metered gateway?
4. Are **redistributable API credentials** (as opposed to our single shared key)
   available per end user, so that each user holds their own TypeSafe credential
   rather than ours? This would resolve the credential-sharing clause directly,
   and we would be glad to implement it if it is the shape you require.
5. **Can the documentation be redistributed** under MIT, or should
   INSTRUCT_JEV come down? (Section 5.)
6. May we use the name and logo of Jev / TypeSafe AI in our README and
   dashboard to describe what the integration is?

## 7. What we are not asking

- We are **not** asking for unlimited or uncapped spend. Every seat has a credit
  balance, and when it is spent the seat stops calling.
- We are **not** asking to resell raw API access or act as an open proxy. Every
  request passes through our gateway and is metered against an identified,
  consenting user.
- We are **not** asking to publish benchmarks or performance data about your
  interfaces.
- We are **not** asking to train a competing model.
- We are **not** charging our users anything. The service is free to them, and a
  user's balance is a cost ceiling we set for ourselves against our own
  subscription rather than a tariff we charge them.

### One thing we want to be explicit about

We may later charge for hosted access, or offer the gateway with a managed tier.
**We are not asking for that permission here and it is not covered by whatever
you grant in response to this letter.** If we pursue it, we will come back and
ask separately, with the commercial terms at that point.

We would rather tell you that now than have you discover it later. A permission
that turns out to cover more than the thing it was granted for is worse than no
permission at all.

If the answer is no, we will keep KD JEV MCP as an internal and open-source
gateway for ourselves and our own team, and drop hosted multi-user operation
entirely. That is a workable outcome for us, and the open-source gateway remains
useful either way.

## 8. Contact

- **Project:** `github.com/ctaxnagomi/kd-jev-mcp`
- **Maintainer:** ctaxnagomi (`wan.mohd.azizi.seggaf@gmail.com`, GitHub)
- **Enterprise contact:** <fill in>
- **Sales:** the "Contact sales" link at <https://typesafe.ai> if an agreement
  is the right route.

---

*Prepared against the terms as published on <https://typesafe.ai/terms>. If
those terms have changed since, please treat this as describing our
understanding and correct us where it is wrong.*