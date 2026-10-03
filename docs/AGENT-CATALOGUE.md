# KD JEV MCP — Agent + JEV Catalogue

Design catalogue for the agent configurations KrackedDevs intends to ship through
the JEV Fabricator. Every configuration is expressed as a pair: **what the LLM
agent generates**, and **what JEV decides**. That split is the whole design.

---

## How to read this

### The invariant

**JEV cannot generate.** It returns typed decisions with calibrated confidence
and probability distributions. It never writes prose, code, or plans.

Therefore every configuration below separates two responsibilities:

| | Responsibility | Mechanism |
|---|---|---|
| **Agent (LLM)** | Generate — prose, code, plans, images, edits | Claude, GPT, or whatever the host runs |
| **JEV** | Decide — route, gate, arbitrate, verify | `choice` / `noul` / `score` over the gateway |

A configuration that assigns generative work to JEV is a misdesign. If a spec
ever says "JEV writes the report", it is wrong.

### The four JEV roles

These are the only four things JEV is asked to do anywhere in this catalogue.
If a proposed use does not reduce to one of them, it does not belong in the system.

1. **Router** — `choice` over candidates, before fan-out. One call instead of paying for all of them.
2. **Gate** — `noul` for a calibrated 0..1, driving an escalation ladder.
3. **Arbiter** — `score` or `choice` to aggregate several agent outputs into one verdict, with a distribution that shows consensus strength.
4. **Verifier** — `score` / `noul` before an expensive or irreversible action.

Confidence is the load-bearing output. `if (confidence < τ) escalate` is the
primitive that makes the whole system adaptive rather than a fixed pipeline.

### Anti-patterns that this catalogue exists to prevent

| Anti-pattern | Why it fails | Correct shape |
|---|---|---|
| Score a 3,000-line diff | `state` caps at 64,000 chars; this is not what the primitive does | Score the *claim* or *summary*, not the artifact |
| Poll JEV inside a tight loop | Each call is a network round trip and is charged | Batch into one `reason` call |
| Ask one broad "which agent?" question | Hides several judgements behind one answer | Several narrow questions, combine in code |
| Let JEV decide *what to build* | Design intent is not a classification problem | Agent drafts, JEV verifies the draft |
| Install tooling without consent | Arbitrary code execution in the user's workspace | Gated policy gate, project-scoped by default |

### Standing constraints

- **Licensing.** TypeSafe's Interface terms grant API access "solely for the
  purpose of evaluating", forbid sharing credentials with third parties, and
  forbid using the interfaces to provide a product or service to a third party.
  An agent running in the user's own workspace with the user's own token is
  within the terms as written. A **shared hosted** execution tier is not, until
  [`TYPESAFE-PERMISSION-REQUEST.md`](TYPESAFE-PERMISSION-REQUEST.md) is answered.
  See [Where these agents run](#where-these-agents-run).
- **Quota.** Charged per tool call. A swarm of *K* agents with routing and
  arbitration costs at least *K*+2 calls. Design for batching.
- **High-liability roles.** Finance and tax roles are scoped to *assist and
  pre-validate*. A human submits. This is a product decision, not a limitation.

### Where these agents run

Every configuration below is deliberately execution-location agnostic. Two tiers:

| Tier | Who runs it | Quota borne by | Licensing status |
|---|---|---|---|
| **Local** — user's workspace, user's token | The user | User | Within terms as written |
| **Hosted** — shared multi-tenant execution | KrackedDevs | Operator | **Blocked** pending permission |

The Fabricator emits a `tier` field per agent. Until the permission request is
answered, **the Fabricator must refuse to create `tier: hosted` agents** rather
than create them and fail later.

---
---

# A — Orchestrator + SDK execution layer

## A1 — Orchestrator (reasoning) + Execution layer

### Statement

A single long-lived agent owns *what should happen*; a separate execution layer
owns *doing it*, resolving configuration, routing, and policy. Neither can act
without the other's permission.

### Role split

| | |
|---|---|
| **Orchestrator (LLM)** | Interpret intent, decompose into steps, draft the plan, write tool invocations |
| **Execution layer** | Resolve config from the workspace, enforce policy, route to the actual tool, collect results |
| **JEV** | Route the request to a domain. Gate whether the execution layer may proceed. Verify the plan before it runs. |

### The two-JEV structure

```
user intent
     │
     ▼
┌─────────────────────────────────┐
│ ORCHESTRATOR AGENT (LLM)        │  drafts plan
└─────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────┐
│ JEV #1 — ROUTER                 │  choice: which execution domain?
│ "which subsystem owns this?"     │  → returns winner + distribution
└─────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────┐
│ JEV #2 — POLICY GATE            │  noul: is this action permitted
│ "is this action permitted under  │  under the workspace policy?"
│  the workspace policy?"         │  → 0..1 + criteria
└─────────────────────────────────┘
     │  p < τ  → refuse / ask user
     ▼
┌─────────────────────────────────┐
│ EXECUTION LAYER                 │  config · routing · policy · dispatch
│  config → route → enforce → run │
└─────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────┐
│ JEV #3 — VERIFIER               │  score: did it do what was asked?
└─────────────────────────────────┘
```

Three JEV calls per orchestration. Not one. That is the point: routing, policy,
and verification are *different judgements* and a single broad question hides all
three.

### Questions

**Router — narrow, one per subsystem.** Do not ask "which agent?".

```jsonc
// JEV #1
{ "instructions": "Which subsystem of this workspace owns the requested change?",
  "state": "<workspace manifest: languages, frameworks, detected files>",
  "options": {
    "frontend":  { "what": "UI, styling, components, client state",
                   "not_for": "server logic, data migrations, CI config" },
    "backend":   { "what": "APIs, persistence, auth, server logic",
                   "not_for": "rendering, CSS, layout" },
    "infra":     { "what": "CI, containers, deployment, IaC",
                   "not_for": "application code" },
    "data":      { "what": "schemas, migrations, pipelines",
                   "not_for": "UI or endpoint logic" }
  } }
```

The `not_for` fields are load-bearing. Neighbouring options separate far better
when the boundary is stated negatively than when descriptions are similar.

**Policy gate — explicit criteria, so 0.7 means something.**

```jsonc
// JEV #2
{ "instructions": "Does the workspace policy permit this action?",
  "criteria": {
    "true":  "action is inside the user's declared scope, touches no path on the deny list, and needs no credential not already granted",
    "false": "action writes outside the workspace, requires a credential the user has not granted, or touches a denied path"
  },
  "state": "<workspace policy document + the concrete proposed action>" }
```

**Verifier — against the plan, not the output.**

```jsonc
// JEV #3
{ "instructions": "Did the executed step satisfy the step's stated acceptance criterion?",
  "state": "<step acceptance criterion> | <observed result>",
  "options": {
    "satisfied":        "result demonstrably meets the criterion",
    "partially":        "result meets part of the criterion, rest unverified",
    "not_satisfied":    "result does not meet the criterion",
    "contradicted":     "result actively violates the criterion"
  } }
```

### Search / scrape

None. A1 must not reach outside the workspace. If the router cannot classify a
request from the workspace manifest, it escalates to the user rather than
searching. Searching is C1's job and carries a different consent model.

### Permissions

A1 needs **no** external program detection. It may read the workspace. It may not
write outside it without a per-action prompt from JEV #2.

### SWOT

| | |
|---|---|
| **Strengths** | Clean separation of intent from effect; policy is enforced at a single choke point (JEV #2) so it cannot be forgotten in a code path; routing is one call instead of *N* agent invocations |
| **Weaknesses** | Three JEV calls of latency before any work starts; the policy gate is only as good as the policy document, and that document is hand-written; a single orchestration verbosity style makes every request pay the 3-call tax |
| **Opportunities** | Policy documents become a per-workspace asset that improves over time; the router distribution reveals ambiguous request classes, which is a free taxonomy of what users actually ask for |
| **Threats** | Policy gate fatigue — users who always click "allow" turn a 0.7 signal into noise, which silently disarms the gate; a compromised workspace manifest could steer the router toward the wrong subsystem |

### SPACE → Decisions

| | S | P | A | C | E |
|---|---|---|---|---|---|
| A1 orchestration | H | H | H | M | H |

| Metric | Rating | Decision |
|---|---|---|
| **S**atisfaction — user sees one coherent answer, not a routing preamble | H | Keep orchestrator and execution in a single conversational surface. Do not surface JEV's routing choice to the user. |
| **P**erformance — correct subsystem chosen first time | H | Keep the router `choice`. Measured against the distribution, not the winner. |
| **A**ccuracy — policy never bypassed | H | Policy gate must be the *only* path to the execution layer. No bypass flag, not even for "trusted" workspaces. |
| **C**ost — 3 JEV calls + agent calls per request | M | Batch JEV #1 and #2 into one `reason` call when the policy doc is small. Do not merge #1 and #2 — routing and permission are different questions. |
| **E**fficiency — user satisfaction per unit cost | H | Cache the router verdict per (intent-cluster, workspace-manifest-hash). Policy verdicts are **never** cached. |

**Resolved decisions:** single-surface UI · router kept separate from gate ·
gate is a hard choke point · route+policy batched when policy doc is small ·
router verdict cached by manifest hash · policy verdicts uncacheable ·
no external search in A1.

---
---

# B — Planner + Swarm

## B1 — Planner agent (suggestive chain-of-thought)

### Statement

A planning agent that produces a *draft* plan, each step annotated with its
suggested reasoning and alternatives considered, which the user edits before
anything executes.

### Role split

| | |
|---|---|
| **Planner (LLM)** | Draft the plan. For each step, state the reasoning and the alternatives it rejected, so the user can audit the reasoning rather than just the output |
| **JEV** | Verify each step's acceptance criterion is actually checkable. Gate whether the plan is worth executing at all. |

### On "suggestive chain-of-thought"

Building this into a product requires care. The goal is **auditable justification
for a decision**, not a transcript of the model's internal reasoning. What ships
is:

- the **decision** and the **criteria** used to make it
- the **alternatives** considered and why each was rejected
- the **confidence** JEV assigned, and what would change it

That is legitimately reviewable and defensible. Surfacing raw model reasoning as
a product feature is not something to build on. Design the UI around the first
three, and let JEV's confidence be the fourth — it is calibrated, whereas the
model's own stated certainty is not.

### Questions

**Is this step checkable?** — a surprisingly high-value gate, because most bad
plans fail here first.

```jsonc
{ "instructions": "Is this step's acceptance criterion objectively verifiable?",
  "criteria": {
    "true":  "a specific artefact or value can be checked by a tool or a person without further interpretation",
    "false": "acceptance requires a judgement call, an opinion, or information not obtainable in the workspace"
  },
  "state": "<step: description + acceptance criterion>" }
```

**Plan-level gate** — batched across all steps in one `reason` call:

```jsonc
{ "instructions": "Is this step ready to execute as written?",
  "state": "<full plan>",
  "options": {
    "ready":       "inputs available, criterion checkable, no open dependency",
    "needs_input": "blocked on information the user must supply",
    "premature":    "depends on a later step's output",
    "unclear":      "criterion is ambiguous"
  } }
```

### Search / scrape

Optional, and only on explicit user request per step. Research is C1's job; B1
may hand a step to C1 rather than searching itself.

### Permissions

Read the workspace. Writes nothing — the plan is a document until approved.

### SWOT

| | |
|---|---|
| **Strengths** | The user audits reasoning rather than output, which catches bad plans earlier; the "is this checkable" gate is cheap and kills the most common failure mode before execution |
| **Weaknesses** | Plan drafts are token-expensive — long plans with per-step alternatives are the single most expensive artefact in the system; a user who does not read alternatives pays full cost for no benefit |
| **Opportunities** | Rejected alternatives become a decision log that improves future plans; high-τ gate values identify which steps consistently need human input, informing the escalation ladder |
| **Threats** | Plan-review fatigue, where users approve without reading, converting the whole feature into a slower version of the thing it replaces; confident-but-wrong plans are more persuasive than no plan |

### SPACE → Decisions

| | S | P | A | C | E |
|---|---|---|---|---|---|
| B1 planner | H | M | H | L | M |

| Metric | Rating | Decision |
|---|---|---|
| **S**atisfaction | H | Show alternatives **collapsed by default**. The reasoning is available, not forced. |
| **P**erformance | M | Plans execute in whatever order is safe, not the order drafted. Order is not correctness. |
| **A**ccuracy | H | The checkability gate is mandatory and cannot be disabled. |
| **C**ost — per-step alternatives are expensive | L | Cap alternative count at 2 per step. Generate the third only if the first two tie in JEV's distribution. |
| **E**fficiency | M | Skip the plan entirely for single-step requests. A one-step plan is pure overhead. |

**Resolved decisions:** alternatives collapsed by default · max 2 alternatives,
third only on a JEV tie · checkability gate mandatory · no plan for single-step
requests · plan order is advisory, execution order is policy-determined.

---
---

## B2 — Swarm agent (high reasoning output efficiency)

### Statement

Fan out *K* agents over a decomposable problem, then aggregate their outputs
through JEV rather than through a further LLM conversation.

### Role split

| | |
|---|---|
| **Swarm members (LLM)** | Each attacks one facet. They generate; they do not vote. |
| **JEV** | Route: decide which members are needed at all. Arbitrate: collapse their outputs into one verdict. Gate: decide whether to deepen the swarm. |

### The efficiency claim, honestly stated

"JEV as arbiter" is cheaper than an LLM aggregator because it is **one call
against a distribution** instead of a conversation that must read *K* full
outputs. But it is not free, and the honest accounting is:

```
Cost(K) = 1 route + K member calls + 1 arbitration
```

The saving versus an LLM aggregator is in the *aggregation* step, not the swarm.
The real efficiency win comes from **not spawning all K members**, which is the
router's job. A swarm that always fans out to *K* is *less* efficient than no
swarm at all.

### Confidence-gated depth

This is the pattern that makes a swarm adaptive:

```jsonc
// Before spawning member i
{ "instructions": "Can this facet be answered from what is already known?",
  "criteria": {
    "true":  "existing member outputs already determine this facet",
    "false": "this facet needs its own investigation"
  },
  "state": "<question> | <outputs so far>" }
```

Member count becomes a function of problem difficulty rather than a constant.
That is the actual "high reasoning output efficiency" — and it is only possible
because the confidence is external and calibrated.

### Questions

**Arbiter — the core call. Score each candidate, then pick.**

```jsonc
// Step 1: score every candidate against one ladder (single batched `reason` call)
{ "instructions": "How well does this candidate answer the question?",
  "state": "<question> | <candidate output>",
  "levels": ["incorrect", "partially correct", "correct but incomplete", "correct and complete"] }

// Step 2: read the distribution. Take the argmax. If the top two are within
// δ of each other, arbitrate explicitly rather than accepting an arbitrary winner.
```

The step-2 rule matters. When two candidates score 0.44 and 0.42, JEV is telling
you the swarm did not converge. Picking the top one anyway hides a genuine
disagreement. Escalate instead — that is the whole value of having a
distribution instead of a label.

**Consensus check:**

```jsonc
{ "instructions": "Do the members agree on the conclusion?",
  "criteria": {
    "true":  "members reach the same conclusion or a compatible superset",
    "false": "members reach materially different conclusions"
  },
  "state": "<all member conclusions, condensed to one line each>" }
```

Condensing first is deliberate — passing *K* full outputs as `state` will hit the
64,000-character cap and degrades the judgement.

### Search / scrape

Members may search if the swarm question requires it, with the same consent model
as C1. Prefer handing to C1 over duplicating fetch logic in every member.

### Permissions

Members are sandboxed to their assigned facet. A member may not write to the
workspace; only the aggregator's result is applied, after verification.

### SWOT

| | |
|---|---|
| **Strengths** | Adaptive member count rather than fixed fan-out; disagreement is detected rather than averaged away; arbitration is one call and returns a distribution, unlike an LLM vote |
| **Weaknesses** | The benefit is conditional on *not* fanning out fully, so a naive implementation is pure overhead; member outputs must be condensed before arbitration, adding a summarisation step that can itself distort; a swarm that always agrees tells you nothing about whether it is right |
| **Opportunities** | The near-tie signal is a high-quality difficulty detector for the escalation ladder; per-facet scores build a capability profile of which swarm members are worth keeping |
| **Threats** | Quota exhaustion from unbounded fan-out, which is the most likely way this configuration harms a user; correlated members agreeing on the same wrong answer, which a distribution cannot detect; condensation dropping exactly the detail that mattered |

### SPACE → Decisions

| | S | P | A | C | E |
|---|---|---|---|---|---|
| B2 swarm | M | H | H | L | H |

| Metric | Rating | Decision |
|---|---|---|
| **S**atisfaction | M | Swarm is invisible to the user. One answer, with a visible confidence band. |
| **P**erformance | H | Confidence-gated member spawning is mandatory, not an optimisation. |
| **A**ccuracy | H | Near-tie (top two within δ) **must** escalate. Never break the tie arbitrarily. |
| **C**ost — worst in the catalogue | L | Hard cap on member count per request. Default 4. Batching is mandatory. |
| **E**fficiency | H | Skip the swarm entirely when the confidence gate says the question is already answered — measure and report this hit rate. |

**Resolved decisions:** swarm invisible to user · confidence-gated spawning mandatory ·
near-tie escalates · hard cap 4 members default · condensation step is explicit and
must state what it dropped · skip swarm when gate says answered · track swarm skip rate
as the primary efficiency metric.

---
---

# C — Research, tool orchestration, policy gating, dual expertise

## C1 — Research agent (dual-fetch: workspace directory + SEO search)

### Statement

One agent that answers a research question by fetching from **both** the user's
selected local data paths **and** current web results, then reconciles them.

### Role split

| | |
|---|---|
| **Researcher (LLM)** | Query formulation, fetching, reading, synthesis with explicit source attribution |
| **JEV** | Decide which source class is authoritative for this claim. Gate whether a fetched source is trustworthy enough to cite. Detect contradiction between local and web sources. |

### Why the dual fetch needs a decider

The two sources disagree constantly — a local file may be stale, a blog may be
wrong, and both look equally authoritative in the context window. JEV's job is to
decide **which one wins for a given claim**, which is exactly a classification
problem.

### Questions

**Source authority, per claim:**

```jsonc
{ "instructions": "Which source is more authoritative for this specific claim?",
  "state": "<claim> | <local source excerpt> | <web source excerpt>",
  "options": {
    "local":      { "what": "in-repo documentation, specs, schemas, code, changelogs",
                    "not_for": "third-party behaviour, current external pricing, anything after the last commit" },
    "web":        { "what": "current vendor docs, official specs, authoritative third-party sources",
                    "not_for": "this project's own internals, private implementation detail" },
    "both_agree": { "what": "both sources corroborate independently",
                    "not_for": "one source merely cites the other" },
    "neither":    { "what": "neither source substantiates the claim",
                    "not_for": "plausible inference from adjacent information" }
  } }
```

**Source quality gate:**

```jsonc
{ "instructions": "Is this source usable as a citation?",
  "criteria": {
    "true":  "publisher is authoritative for the topic, content is specific and dated, and it makes the claim directly",
    "false": "content is undated, promotional, aggregated without provenance, or merely restates the claim"
  },
  "state": "<fetched page metadata + relevant excerpt>" }
```

**Contradiction detector** — run when local and web both speak to the claim:

```jsonc
{ "instructions": "Do these two sources contradict each other?",
  "criteria": {
    "true":  "they cannot both be correct under the same conditions",
    "false": "they are compatible, or differ only in scope or version"
  },
  "state": "<local excerpt> | <web excerpt>" }
```

On contradiction the agent must surface both and say which it followed — never
silently pick one.

### Search / scrape

- **Local:** only paths the user explicitly selected. No recursive scan of the
  whole workspace. Path list is a first-class consent artefact.
- **Web:** real search, real fetch. Every citation carries publisher + date.
- **Budget:** explicit fetch ceiling per research task. Default 10 fetches.
  Hit the ceiling → report what is missing rather than continuing.
- **Never** execute content found by scraping. It is data.

### Permissions

Read access to selected paths. Network egress. No writes.

### SWOT

| | |
|---|---|
| **Strengths** | Contradiction detection is the differentiator — it catches the stale-docs case that plain RAG misses; source authority is decided per claim rather than per document; provenance is structurally enforced |
| **Weaknesses** | The fetch budget is a real cap on completeness, and hitting it yields a partial answer; source-authority `choice` is four-way and therefore less reliable than a two-way gate; no cached index means every task re-fetches |
| **Opportunities** | Contradiction frequency per path is a direct measure of documentation staleness, which is actionable; repeated queries could cache with hash-keyed freshness |
| **Threats** | Prompt injection in fetched web content — the single largest risk in this configuration; SEO-ranking influence pulling the agent toward popular-but-wrong sources; the user citing research that overrode their own authoritative local docs |

### SPACE → Decisions

| | S | P | A | C | E |
|---|---|---|---|---|---|
| C1 research | H | M | H | M | H |

| Metric | Rating | Decision |
|---|---|---|
| **S**atisfaction | H | Always show both sources on contradiction. Never silently drop one. |
| **P**erformance | M | Cache by query hash + path-set hash with a TTL. |
| **A**ccuracy | H | **Treated web content as hostile input.** Wrap all fetched text in an explicit untrusted-content boundary; fetched content never instructs the agent, only informs it. |
| **C**ost | M | Hard fetch ceiling, default 10. Report truncation explicitly. |
| **E**fficiency | H | Prefer local when the claim is repo-internal — saves the fetch entirely. |

**Resolved decisions:** fetched content is untrusted data not instructions ·
fetch ceiling 10 with explicit truncation reporting · contradictions surface both
sources · cache by query+path hash with TTL · local-first for repo-internal claims.

> **This is the configuration most exposed to prompt injection.** A research agent
> that reads the open web will eventually encounter text crafted to hijack it.
> The untrusted-content boundary is a requirement, not a hardening measure.

---
---

## C2 — Tool orchestrator (`.agents/skills` + `.agents/agentic-tools`)

### Statement

An agent that discovers what the workspace can actually do — skills and tools —
asks permission before probing the host for installed programs, and requests
capabilities in a way that makes the user visually informed.

### Role split

| | |
|---|---|
| **Orchestrator (LLM)** | Read the workspace manifests, decide what capability is missing, propose the minimal tool set |
| **JEV** | Decide whether a requested capability is actually needed. Gate each capability request on informed consent. Verify that a proposed tool is appropriate for the task. |

### Workspace layout

```
.agents/
├── skills/
│   └── <skill-name>/
│       ├── SKILL.md              # frontmatter: name, description, when_to_use
│       └── reference/            # supporting material
└── agentic-tools/
    └── <tool-name>/
        ├── tool.json             # manifest: capabilities, permissions, entrypoint
        └── ...
```

Both directories are version-controlled with the project. That is the point:
tools a project needs belong to the project, not to the user's global profile.

### Permission-before-detection

The requirement is correct and important. Capability detection — probing for
Paint, Blender, Word — is reconnaissance over the user's installed software.
It must be opt-in, specific, and explainable.

**The consent artefact is a manifest, not a prompt.** Rather than letting the
agent discover programs by scanning, the workspace declares what it needs:

```jsonc
// .agents/capabilities.json
{
  "capabilities": [
    { "id": "word-processor",
      "why":  "output must be a .docx deliverable",
      "probe": { "kind": "registry-or-path",
                 "candidates": ["Word.Application", "LibreOffice.Writer"],
                 "installs_nothing": true },
      "grants": ["read/write documents in the output directory"] },
    { "id": "vector-graphics",
      "why":  "output must be an editable .svg/.blend asset",
      "probe": { "kind": "path",
                 "candidates": ["Blender", "Inkscape"],
                 "installs_nothing": true },
      "grants": ["write assets to the output directory"] }
  ]
}
```

Probe kinds are constrained to **detect-only**. Detection reads the registry or
checks for known paths; it never launches an application, never installs, and
never prompts for the program's own permissions. Detection results are reported
as present/absent — the user learns what exists without anything being started.

**A capability is only requested when JEV agrees it is required:**

```jsonc
{ "instructions": "Is this capability necessary to complete the task?",
  "criteria": {
    "true":  "the task's deliverable format or required step cannot be met without it",
    "false": "a built-in approach, or a different tool, would produce an equivalent deliverable"
  },
  "state": "<task description> | <requested capability + its declared purpose>" }
```

The `"false"` criterion naming *"a different tool would work"* is deliberate. It
is the clause that stops the agent from demanding Blender because it noticed
Blender.

### "Visually designed with high standard base foundations"

Interpreted as two separate obligations, because conflating them is how design
systems rot:

1. **Base foundations** — a fixed, documented design system: spacing scale, type
   scale, colour tokens, contrast ratios, grid. Deterministic and testable.
   JEV verifies conformance: `score` the artefact against the token set.
2. **User preference** — the visual taste layer, gathered once at intake
   (C4/Fabricator) and stored as a preference record.

Foundations are enforced; preferences are applied. Never the reverse.

### Search / scrape

None. Capability discovery is local and manifest-driven. Web search here would
mean fetching *untrusted code*, which is a different and much larger risk — see
D12.

### Permissions

Read workspace manifests. **Explicit, per-capability user consent**, naming the
program and what it will be granted. Writes restricted to declared output paths.

### SWOT

| | |
|---|---|
| **Strengths** | Manifest-driven detection means the agent never guesses what to probe; detect-only probing cannot be coerced into launching something; design foundations become checkable rather than aspirational |
| **Weaknesses** | Manifests are hand-maintained and go stale; probe lists are platform-specific and break on version changes; the capability vocabulary (what counts as "vector graphics"?) has to be curated, not generated |
| **Opportunities** | Capability manifests become a portability contract — the project declares what it needs and the user learns what is missing before starting; conformance scoring turns design review into a number |
| **Threats** | A malicious `tool.json` in a cloned repository requesting broad grants — this is the highest-severity risk in the catalogue; over-prompting trains users to approve blindly, defeating consent |

### SPACE → Decisions

| | S | P | A | C | E |
|---|---|---|---|---|---|
| C2 tool orchestrator | H | M | M | M | M |

| Metric | Rating | Decision |
|---|---|---|
| **S**atisfaction | H | One consolidated consent screen for all capabilities. Never one prompt per program. |
| **P**erformance | M | Capabilities cached per session after first detection. |
| **A**ccuracy | M | Untrusted-repository `tool.json` is **the** threat. See the isolation decision below. |
| **C**ost | M | Detection is cheap; the consent UI is the expensive part. |
| **E**fficiency | M | Skip detection entirely when the manifest declares nothing. |

**Resolved decisions:** manifest-driven, detect-only probes, never launch ·
one consolidated consent screen · JEV necessity check before every capability
request · capabilities session-cached · untrusted repo tool.json requires
explicit per-tool approval with the file diff shown · design foundations
machine-checked, preferences stored separately.

> **Untrusted tool manifests.** A `tool.json` from a cloned repository is an
> untrusted input requesting elevated local capability. Minimum bar: show the
> manifest diff before approving, default to project-scoped grants, never
> auto-approve, and never grant global scope from a repository-supplied file.

---
---

## C3 — Gated policy agent (first-run codebase scan)

### Statement

On first run, scan the codebase to propose a workspace policy, present it for
review, and persist it only once accepted.

### Role split

| | |
|---|---|
| **Agent (LLM)** | Scan the codebase, infer the project's conventions, draft a proposed policy |
| **JEV** | Decide whether the scan is confident enough to propose a policy at all. Decide whether a proposed policy change is a clarification or a loosening. Gate the write. |

### Why the gate matters more than the scan

A generated policy that is silently wrong is worse than no policy: it grants
confidence it has not earned. The gate is the product.

### Questions

**Is the scan confident enough to propose?**

```jsonc
{ "instructions": "Is there enough evidence to propose a workspace policy?",
  "criteria": {
    "true":  "conventions are consistent across the codebase and at least one of each proposed rule is corroborated by many files",
    "false": "conventions are inconsistent, the codebase is very small, or multiple contradictory patterns compete"
  },
  "state": "<scan findings: candidate rules + file counts supporting each>" }
```

Inconsistent codebase → the correct output is **"ask the user"**, not a guess.
That is the single most important behaviour in this configuration.

**Classification vs loosening — on every policy change:**

```jsonc
{ "instructions": "Does this change make the policy more restrictive, less restrictive, or equivalent?",
  "state": "<current rule> → <proposed rule> | <codebase evidence>",
  "options": {
    "tighten":    "proposed rule permits strictly less than before",
    "loosen":     "proposed rule permits strictly more than before",
    "equivalent": "same permission in substance, different wording"
  } }
```

`loosen` requires explicit user confirmation and is highlighted in the UI.
`tighten` can be applied silently. `equivalent` needs no prompt.

### Scan scope

Explicitly enumerated in the consent screen: which directories are read, which
file types are parsed, what is never read (`.env`, secrets, key material,
anything on a deny list).

`.env` files and detected credentials are **excluded by default**, and the
exclusion is stated in the consent screen rather than assumed.

### Permissions

Read: declared directories only, minus declared secret paths.
Write: the single policy file, only after acceptance.

### SWOT

| | |
|---|---|
| **Strengths** | Policy becomes specific to the project rather than generic; the "ask, don't guess" rule prevents confidently wrong policy; tighten/loosen classification makes policy drift visible |
| **Weaknesses** | Only as good as the scan, and small codebases cannot support inference; proposed rules read as authoritative and may crowd out user judgement; policy drift needs a mechanism nobody has built yet |
| **Opportunities** | The scan doubles as onboarding — "here is what we inferred about your project" is valuable regardless of whether policy is accepted; contradicted rules surface genuine architectural inconsistency |
| **Threats** | An over-permissive inferred rule gets accepted uncritically and persists; a malicious codebase (e.g. a poisoned dependency) could include files crafted to induce a permissive rule |

### SPACE → Decisions

| | S | P | A | C | E |
|---|---|---|---|---|---|
| C3 policy gate | M | M | H | L | M |

| Metric | Rating | Decision |
|---|---|---|
| **S**atisfaction | M | Present as an editable proposal, never as a fait accompli. |
| **P**erformance | M | No policy accepted silently. First run always asks. |
| **A**ccuracy | H | Low confidence → ask, do not guess. Secret paths excluded by default and stated. |
| **C**ost — scan is cheap; review is not | L | Cap proposed rules at ~10. Beyond that nobody reads them. |
| **E**fficiency | M | Re-scan only on demand or on a manifest change, never on a timer. |

**Resolved decisions:** low-confidence scan asks instead of guessing · secret
paths excluded by default and declared in consent · `loosen` always confirmed,
`tighten` silent · max ~10 proposed rules · re-scan on demand only.

---

## C4 — Dual expert: coding + frontend/UI-UX

### Statement

Two coupled agents, both JEV-gated: one owns implementation correctness, one owns
interface quality. Neither can declare the work finished alone.

### Role split

| | |
|---|---|
| **Coding expert (LLM)** | Correctness, types, error paths, tests, performance |
| **Frontend expert (LLM)** | Layout, responsive behaviour, accessibility, interaction correctness |
| **JEV** | Verify both independently. **Arbitrate** the conflict when they disagree. Gate the merge. |

### Arbitration is the point

Coding and frontend disagree constantly, and both are locally reasonable:
`overflow-x: hidden` fixes a horizontal scroll and masks an underlying layout
bug. The frontend expert proposes it; the coding expert objects. A single agent
would silently pick one. Two agents plus an arbiter makes the disagreement
legible.

```jsonc
// Both disagreements land here.
{ "instructions": "Which resolution is correct?",
  "state": "<conflict> | <coding expert position> | <frontend expert position>",
  "options": {
    "coding":       { "what": "correctness-first resolution",
                      "not_for": "cosmetic regressions the user will see" },
    "frontend":     { "what": "interface-first resolution",
                      "not_for": "masking a layout defect with overflow clipping" },
    "both":         { "what": "a resolution satisfying both positions",
                      "not_for": "an unresolved trade-off" },
    "escalate":     { "what": "genuine trade-off requiring the user's preference",
                      "not_for": "a question one of the two should have answered" }
  } }
```

### Responsive requirements — concrete

This is specified as enforceable rules rather than intent.

**1. No horizontal overflow at any width.**

`overflow-x: hidden` on `html, body` is **not** a fix — it hides the symptom and
disables the user's ability to reach content. Fix the offending element instead.
The detector is a scroll check, not a CSS rule:

```js
// Layout regression detector — no element may exceed the viewport width.
function findOverflow() {
  const vw = document.documentElement.clientWidth;
  const bad = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;         // not rendered
    if (getComputedStyle(el).position === 'fixed') continue; // deliberate
    if (r.right > vw + 1 || r.left < -1) {
      bad.push({
        sel: el.tagName.toLowerCase() +
             (el.id ? '#' + el.id : '') +
             (el.className && typeof el.className === 'string'
               ? '.' + el.className.trim().split(/\s+/).join('.') : ''),
        width: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right)
      });
    }
  }
  return bad;
}
```

Run at 320 / 360 / 390 / 414 / 768 / 1024 / 1280 / 1536 / 1920. Any hit is a
blocking failure.

**2. iOS input must not trigger zoom.**

The cause is specific and worth stating: **iOS Safari zooms when a focused input's
computed font-size is below 16px.** It is not a gesture problem, it is a
font-size threshold. So the fix is a floor, not a viewport meta tag:

```css
/* Every text input, at every viewport. 16px is the threshold, not a preference. */
input, textarea, select { font-size: max(16px, 1em); }
@media (max-width: 480px) {
  input, textarea, select { font-size: 16px; }
}
```

**3. Double-tap zoom — the accessible way.**

```html
<meta name="viewport"
      content="width=device-width, initial-scale=1, viewport-fit=cover">
```

```css
/* Suppresses double-tap-to-zoom without disabling pinch. */
button, a, label, [role="button"] { touch-action: manipulation; }
```

> `user-scalable=no` is deliberately **not** used. It breaks WCAG 2.1 SC 1.4.4
> (Resize Text) and SC 1.4.10 (Reflow), and iOS has ignored it since Safari 10 —
> it would cost accessibility compliance and buy nothing. The 16px input floor
> plus `touch-action: manipulation` achieves the requested behaviour *and* keeps
> the page zoomable for users who need it.

**4. Hidden scrollbars — visually, while staying scrollable.**

```css
* { scrollbar-width: none; -ms-overflow-style: none; }
::-webkit-scrollbar { width: 0; height: 0; display: none; }
```

Note this hides the *indicator*, not the *function* — scrolling still works. Any
element relying on a visible scrollbar for affordance must carry an alternative
cue.

**5. Safe areas and dynamic viewport units.**

```css
:root { --sat: env(safe-area-inset-top, 0px);
        --sab: env(safe-area-inset-bottom, 0px); }
.full-bleed { padding-left: max(var(--sat), 16px);
              padding-right: max(var(--sat), 16px); }
.sticky-footer { padding-bottom: max(var(--sab), 12px); }
/* Prefer dvh for mobile browser chrome; 100vh overflows on iOS. */
.app-shell { height: 100dvh; }
```

### Verification gate

All five requirements become checks, and both experts must pass:

```jsonc
{ "instructions": "Does this implementation meet all stated viewport requirements?",
  "state": "<detector results per breakpoint + a11y audit output>",
  "options": {
    "compliant":     "zero overflow at all breakpoints, no input below 16px, zoom preserved, scrollbars hidden, safe areas respected",
    "partially":     "one requirement unmet",
    "non_compliant": "two or more unmet, or a requirement was bypassed rather than met"
  } }
```

### Search / scrape

Coding expert: local only — types, definitions, existing patterns.
Frontend expert: local only, plus visual regression baselines if the project has
them. **Neither scrapes the web for implementations** — C1 does that, and pasted
web code arrives pre-poisoned.

### Permissions

Read the workspace. Write the implementation. Merge requires both gates.

### SWOT

| | |
|---|---|
| **Strengths** | The viewport rules are testable, so "responsive" stops being a claim; disagreement between specialists becomes an explicit arbitration instead of a silent choice; the iOS zoom requirement is solved at its actual cause |
| **Weaknesses** | Two agents roughly double the cost of frontend work; arbitration adds a third JEV call and can deadlock on genuinely subjective trade-offs; the detector runs in a real browser, which is slow in CI |
| **Opportunities** | The overflow detector generalises into a reusable layout-regression guard for any project; the arbitration pattern is reusable wherever specialists have competing local correctness (a11y vs performance, security vs UX) |
| **Threats** | Arbitration fatigue if specialists routinely disagree, pushing toward accepting one side without the gate; the 16px floor slightly reduces input density on small screens, a real tradeoff the team may reject |

### SPACE → Decisions

| | S | P | A | C | E |
|---|---|---|---|---|---|
| C4 dual expert | H | H | H | L | H |

| Metric | Rating | Decision |
|---|---|---|
| **S**atisfaction | H | User sees one change, not two agents arguing. |
| **P**erformance | H | All five viewport requirements are hard gates. A near-miss does not pass. |
| **A**ccuracy | H | Both gates must pass independently. No averaging. |
| **C**ost — highest in the catalogue | L | JEV arbitration only on *conflict*. Agreeing specialists cost two verifications, not three calls. |
| **E**fficiency | H | Run the detector before writing code, so violations are found by the design, not by review. |

**Resolved decisions:** all five viewport rules are hard gates · overflow detected
by measurement, never fixed with `overflow-x: hidden` · 16px input floor is the
zoom fix · `user-scalable=no` rejected on accessibility grounds ·
`touch-action: manipulation` for double-tap · scrollbars hidden visually but
function retained · `dvh` over `vh` · arbitration only on conflict ·
both gates required, never averaged.

---
---

## Summary — configurations A through C

| ID | Configuration | Agent side | JEV side | Primary risk |
|---|---|---|---|---|
| A1 | Orchestrator + execution layer | Drafts plan, writes invocations | Router, policy gate, verifier | Gate fatigue disarms the policy check |
| B1 | Planner | Plan + auditable alternatives | Checkability gate, plan gate | Plan-review fatigue |
| B2 | Swarm | K facet generators | Confidence-gated spawn, arbiter | Quota blowout from unbounded fan-out |
| C1 | Research | Query, fetch, synthesise | Source authority, quality gate, contradiction | **Prompt injection from fetched web content** |
| C2 | Tool orchestrator | Manifest reading, capability proposal | Necessity check, consent gate | **Untrusted repo `tool.json`** |
| C3 | Policy gate | Scan, draft policy | Confidence gate, tighten/loosen | Over-permissive rule accepted uncritically |
| C4 | Dual expert | Coding + frontend | Dual verification, arbitration | Arbitration fatigue |

Roles D1–D12 follow in [`AGENT-ROLES.md`](AGENT-ROLES.md).
The first-run personalisation interview is in [`FABRICATOR-INTAKE.md`](FABRICATOR-INTAKE.md).