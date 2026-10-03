# TypeSafe AI — request for multi-tenant gateway permission

**Status:** draft, not yet sent.
**Owner:** KrackedDevs (`kd-jev-mcp`)
**Blocking:** every commercial plan for this project. See *What we are not asking* below.

---

## 1. Who we are

KrackedDevs is a small team building **KD JEV MCP**, an open-source MCP (Model
Context Protocol) gateway for the Jev System One model. It is published at
`github.com/ctaxnagomi/kd-jev-mcp` (MIT).

The project has three parts:

1. **A token gateway.** It holds a single TypeSafe API key as a server-side
   secret and issues per-user `kdj_…` tokens. Each user gets their own monthly
   call quota and per-minute rate limit, enforced in Cloudflare D1.
2. **An OAuth 2.1 authorization server**, so MCP hosts (Claude Code, ChatGPT,
   Cursor, and anything else speaking the MCP OAuth profile) can add the server
   as a connector with a browser consent flow and PKCE, with no pasted token.
3. **A quota and audit plane.** Every call is attributed to a token, and quota is
   charged per tool call rather than per HTTP request, because MCP clients send
   `initialize` and `tools/list` continuously and per-request billing would
   charge users for protocol chatter.

The gateway is deliberately **not** a memory store and **not** a general LLM
proxy. It exposes exactly the three Jev primitives — `choice`, `noul`, `score` —
plus batched `reason`/`usage`/`help`, and forwards them to
`POST /v1/systemone` unchanged. It adds authentication, metering and
authorisation. It does not transform, rank, or repackage your output.

Current scale: capped at **100 users**, one D1 database, one Worker.

## 2. What we need

Written permission — or an enterprise/reseller agreement — to operate
KD JEV MCP as a **multi-tenant gateway**, meaning:

- one TypeSafe API key held server-side by us;
- N end users, each holding a `kdj_…` token issued by us;
- every call forwarded on that user's behalf, attributed to them, metered
  against their own quota, and logged.

We are not asking to resell raw API access or to broker unrestricted use. Our
users get our gateway's rate limiting, quota accounting, audit trail and OAuth
consent flow — not a pipe to your API.

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
| Users consume quota we meter | "provide any product or service to a third party" | Prohibited as written |
| Paid production use | "solely for the purpose of evaluating" | Outside the grant |

We would rather have this confirmed than have you find out later, which is why we
are asking before launch rather than after.

## 4. Mitigations already implemented

These are live in the codebase, not aspirational:

- **Per-user quota and rate limiting**, enforced atomically in D1
  (`UPDATE … WHERE requests_used < quota RETURNING` plus a per-token
  minute-bucket burst limiter). A runaway or abusive token cannot exceed its
  ceiling, so it cannot exhaust your capacity on your behalf.
- **Hard user cap** of 100, enforced server-side.
- **No plaintext credential storage.** Only a SHA-256 hash of each token is
  stored; the token is displayed once at issuance. Your API key is a Worker
  secret and is never returned to any client, logged, or persisted.
- **Full audit trail**: every issuance, rotation, revocation, and failed
  authentication is recorded with timestamp and IP.
- **Immediate revocation.** Revoking a user's token kills every live OAuth
  session derived from it on the next request, and burns any pending
  authorization codes.
- **No content retention.** We store no prompts, states, or answers. Only
  aggregate token counts per user.
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
   gateway adds authentication, quota and audit rather than reselling raw
   access?
2. If not, is there an **enterprise, reseller, or OEM agreement** that would
   cover it? We are willing to sign, to disclose our users, and to take
   per-seat volume commitments.
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

- We are not asking for unlimited or uncapped quota.
- We are not asking to resell raw API access or act as an open proxy. Every
  request passes through our gateway and is metered against an identified,
  consenting user.
- We are not asking to publish benchmarks or performance data about your
  interfaces.
- We are not asking to train a competing model.
- We are not asking for anything now. The project is pre-launch, capped at 100
  users, and currently has no paying customers.

We would rather launch without monetisation than launch in violation of your
terms. If the answer is no, we will keep KD JEV MCP as an internal and
open-source gateway and drop the commercial plans entirely — that is a
workable outcome for us.

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