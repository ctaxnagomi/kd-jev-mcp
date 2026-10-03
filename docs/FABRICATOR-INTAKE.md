# JEV Fabricator — First-Run Personalisation Intake

The `/Fabri-Jev` interview. A design-tree process that ends with a reviewed set of
callable agents, not a generated guess.

The process is the `grilling` discipline applied to a product surface: **rounds**,
a **frontier** of questions whose prerequisites are settled, **recommended answers**
on every question, and **nothing built until the user confirms shared
understanding**.

Related: [`AGENT-CATALOGUE.md`](AGENT-CATALOGUE.md) (configurations A–C) ·
[`AGENT-ROLES.md`](AGENT-ROLES.md) (roles D1–D12)

---

## Purpose and non-goals

**Purpose.** Turn "I don't know what I need" into a specific, reviewed, callable
agent set — with the reasoning shown, so the user can reject any part of it.

**Non-goals.**

- Not to install or run anything during the interview.
- Not to ask the user for facts the machine can look up. See
  [Facts the Fabricator finds itself](#facts-the-fabricator-finds-itself).
- Not to guess. Every unanswerable question routes to the user, never to a default.

The failure this design exists to prevent: a Fabricator that produces a confident
twenty-agent roster for a user who wanted one thing done. **Fewer, correct agents
beats more, plausible agents** — both because each agent costs quota and because
an unused agent is a maintenance liability the user did not agree to.

---

## How the intake works

```
        ┌──────────────────────────────────────────┐
        │  Round 1 — root frontier                 │  no prerequisites
        │  job · scope · autonomy · workspace      │
        └──────────────────┬───────────────────────┘
                           │  answers reshape the tree
                           ▼
        ┌──────────────────────────────────────────┐
        │  Round 2 — dependent frontier            │  derived from R1
        │  stack · configuration · jurisdiction ·  │
        │  design preference                       │
        └──────────────────┬───────────────────────┘
                           ▼
        ┌──────────────────────────────────────────┐
        │  Round 3 — risk frontier                 │
        │  thresholds · high-risk roles · channels │
        │  · quota budget                          │
        └──────────────────┬───────────────────────┘
                           ▼
        ┌──────────────────────────────────────────┐
        │  Round 4 — confirmation                  │
        │  "are you satisfied?"                    │
        └──────────────────┬───────────────────────┘
                           │  satisfied
                           ▼
        ┌──────────────────────────────────────────┐
        │  Proposal — table of agents + checkmarks │
        │  → user accepts / amends                 │
        └──────────────────┬───────────────────────┘
                           │  accepted
                           ▼
        ┌──────────────────────────────────────────┐
        │  Build — agents persisted to D1,          │
        │  exposed as MCP tools                    │
        └──────────────────────────────────────────┘
```

Two properties of this loop are load-bearing:

1. **The frontier is recomputed after every round.** Settled answers push the
   frontier outward and unblock questions that depended on them. A question whose
   answer depends on another question still open in the same round belongs to a
   *later* round — never asked speculatively.
2. **Nothing is created before the satisfaction gate.** The user always sees the
   full proposed roster before any of it exists.

---

## JEV gates inside the intake

The interview obeys the same invariant as every other agent in the system: the
LLM asks, **JEV decides**. Four gates run during intake.

### G1 — Is the answer usable?

```jsonc
{ "instructions": "Is this answer specific enough to configure an agent from?",
  "criteria": {
    "true":  "names a concrete workflow, tool, or outcome that could be built",
    "false": "expresses a feeling, a vague aspiration, or something already handled by another tool"
  },
  "state": "<the user's answer in context>" }
```

On `false`, the Fabricator asks one clarifying question rather than accepting a
vague answer and building something unrequested. This is the main defence against
the confident-roster failure.

### G2 — Is the scope coherent?

```jsonc
{ "instructions": "Can these stated goals be served by a coherent agent set?",
  "state": "<all stated goals>",
  "options": {
    "coherent":       "the goals share a workspace and a toolchain",
    "complementary":  "the goals are separate but share tooling and do not conflict",
    "conflicting":    "two goals imply incompatible policies or thresholds",
    "diffuse":        "the goals have no common structure and would produce unrelated agents"
  } }
```

`diffuse` is not an error — it means the Fabricator proposes **two smaller sets**
and asks which to build first, rather than one incoherent set.

### G3 — Is the proposed agent set the right size?

```jsonc
{ "instructions": "Is this the minimum agent set that covers the stated goals?",
  "criteria": {
    "true":  "every agent maps to a stated goal, and removing any one leaves a goal uncovered",
    "false": "an agent duplicates another's coverage, or no stated goal needs it"
  },
  "state": "<stated goals> | <proposed agent set with each agent's goal mapping>" }
```

This is the gate that keeps the roster honest. It should fire **often** — an
intake that proposes twenty agents and passes this gate on the first attempt has
not been checked.

### G4 — Is any high-risk role eligible?

```jsonc
{ "instructions": "Has each high-risk role's precondition been met?",
  "state": "<role> | <its declared precondition> | <evidence the precondition holds>",
  "criteria": {
    "true":  "the role's stated precondition is satisfied by something the user has said or done",
    "false": "the precondition is unmet, unevidenced, or the user has not been told what it requires"
  } }
```

Non-negotiable outcomes, not defaults:

| Role | Precondition | If unmet |
|---|---|---|
| **D11** tax filing | A **named licensed reviewer** exists who will review output | Role not offered. Not "offered disabled" — not offered. |
| **D10** finance | Draft-only mode acknowledged | Offered draft-only; payment never offered |
| **D4** marketing | Draft-only acknowledged; browser access is a separate opt-in | Offered draft-only |
| **D12** router fetch | The six-step precedence is enforced in code | Fetch capability absent; routing still works |

---

## Intake state

Persisted so the intake is resumable and auditable, and so a later `/Fabri-Jev`
amends rather than restarts.

```sql
-- One row per user. The personalisation record.
CREATE TABLE profile (
  id                TEXT PRIMARY KEY,
  token_id          TEXT NOT NULL REFERENCES tokens(id),   -- bound to the holder's token
  job               TEXT,                                   -- free text as given
  role_signals      TEXT,                                   -- JSON: inferred domain, seniority
  goals             TEXT NOT NULL,                          -- JSON: [{goal, priority}]
  autonomy          TEXT NOT NULL CHECK (autonomy IN ('advise','supervised','delegated')),
  workspace_shape   TEXT NOT NULL CHECK (workspace_shape IN ('single_project','multi_project','no_code','mixed')),
  workspace_root    TEXT,                                   -- path, when scannable
  stack             TEXT,                                   -- JSON: detected languages, frameworks, versions
  jurisdiction      TEXT,                                   -- ISO-3166 alpha-2, e.g. 'MY'
  currency          TEXT,
  fiscal_year_start TEXT,
  design_prefs      TEXT,                                   -- JSON: preference record (D5/C2 layer)
  channels          TEXT,                                   -- JSON: enabled notification channels (D9)
  critical_class    TEXT,                                   -- JSON: what bypasses suppression (D9)
  stat_source       TEXT,                                   -- JSON: dated statutory source (D10/D11)
  quota_budget      INTEGER,                                -- monthly JEV calls the user expects
  satisfied_at      TEXT,                                   -- set when the satisfaction gate passes
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per interview round. The audit trail of the intake itself.
CREATE TABLE intake_round (
  id            TEXT PRIMARY KEY,
  profile_id    TEXT NOT NULL REFERENCES profile(id),
  round         INTEGER NOT NULL,
  answers       TEXT NOT NULL,        -- JSON: {question_id: answer}
  g1_confidence REAL,                 -- JEV G1 over the round's answers
  g2_verdict    TEXT,                 -- JEV G2
  frontier      TEXT NOT NULL,        -- JSON: question ids asked this round
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The proposed roster, before it becomes agents. Kept so the accepted proposal
-- is recoverable even after agents are edited or disabled.
CREATE TABLE agent_proposal (
  id          TEXT PRIMARY KEY,
  profile_id  TEXT NOT NULL REFERENCES profile(id),
  role_id     TEXT NOT NULL,          -- A1|B1|B2|C1..C4|D1..D12
  enabled     INTEGER NOT NULL,       -- the checkmark
  rationale   TEXT NOT NULL,          -- ties to a stated goal
  gate_status TEXT,                   -- JEV G3 / G4 verdict
  accepted    INTEGER,                -- user accepted / amended / rejected
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## Round 1 — Root frontier

Nothing is settled, so the frontier is every root decision. Four questions.

---

❓ **Q1** — **What do you do?**: This is the highest-leverage answer in the whole
interview, because it determines which roles are even plausible and it shapes how
every other answer is interpreted. Be as specific as you like — "solo founder
selling B2B SaaS" is far more useful than "entrepreneur".

Options, if you'd rather pick than type:
`founder/owner` · `engineer (specify frontend / backend / fullstack / infra / data)` ·
`designer` · `marketer or content` · `finance or accounting` · `legal or compliance` ·
`student or researcher` · `operations` · `other`

➡️ Answer in your own words rather than picking from the list. The Fabricator
infers the rest, and the inference is shown back to you for correction at the end
of the round.

---

❓ **Q2** — **What do you want KD JEV MCP to handle?**: Name **one to three
primary workflows**, in the form "when X happens, I want Y done". Not a wish list,
not a job description — workflows.

A warning worth stating plainly: every workflow you name becomes a candidate
agent, and every agent spends quota on JEV calls. Naming eight workflows produces
a proposal of eight agents, most of which you will not use.

Options, if it helps to anchor: `ship or modify code` · `write or maintain docs` ·
`research a question` · `marketing or social content` · `graphic or brand assets` ·
`financial admin` · `tax filing` · `reminders and notifications` · `personal
automation` · `team coordination`

➡️ Name the **one** workflow that would make this worth paying for if nothing
else worked. The others can follow in a second pass.

---

❓ **Q3** — **How autonomous should it be?**: This is a policy, not a
preference. It gates every hard gate in the catalogue — whether agents may write
to the workspace, whether anything external happens without asking, and what the
escalation ladder does at low confidence.

- **`advise`** — never acts. Produces plans, reviews, and recommendations. Nothing
  is written or sent.
- **`supervised`** — acts freely inside the workspace, asks before anything
  external or irreversible. Every publish, payment, install, and submission is
  individually approved.
- **`delegated`** — acts on routine steps unattended; escalates only on low
  confidence or an action outside its recorded scope.

➡️ `supervised`. It is the only posture where the escalation ladder in the
catalogue is meaningful without being decorative. `delegated` is genuinely useful
once a configuration is proven, and it is a one-line change later — but starting
there means the confidence gates are untested when they matter most.

---

❓ **Q4** — **What does this run against?**: The workspace determines which
configurations are eligible at all. Several of the strongest — C3's policy scan,
C2's capability manifests, C4's dual expert, D6/D7 — require a real codebase.

- **`single_project`** — one project on disk. Enables the most.
- **`multi_project`** — several. Enables everything, plus per-workspace policy.
- **`no_code`** — no local code; chat, research, reminders, notifications only.
- **`mixed`** — some workflows in a workspace, some not.

➡️ `single_project`. Per-workspace policy is much easier to get right on one
workspace, and a wrong policy is worse than no policy.

---

### End of round 1 — echo back

Before round 2, the Fabricator shows a short summary and **the inferred signals**,
each marked as inferred rather than stated, so errors are caught early:

```
You've told me:
  Job          solo founder, B2B SaaS          [inferred: technical founder]
  Goal         ship features without context-switching
  Autonomy     supervised
  Workspace    ~/projects/atlas (Node + Postgres + React)

Did I get any of that wrong?
```

Corrections here are cheap. Corrections after generation are expensive.

---

## Round 2 — Dependent frontier

Derived from round 1. Questions whose prerequisites are now settled.

---

❓ **Q5** — **Conventions, or should I scan?**: If the workspace is scannable, the
Fabricator can determine languages, frameworks, test setup, and existing patterns
by reading rather than asking.

➡️ **Let it scan.** This is a fact the machine can establish; asking you to report
your own stack is wasted effort and gets worse with larger projects. The scan is
read-only, excludes secret paths, and shows you what it read.

---

❓ **Q6** — **Which configuration family?**:

- **A1** orchestrator + execution layer — for work with a clear plan/execute split.
- **B1** planner — for work where the plan matters more than the execution.
- **B2** swarm — for decomposable problems needing several perspectives.
- **C1** research — for questions answered from your files *and* the web.
- **C2** tool orchestrator — for output that needs programs you may not have.
- **C3** policy gate — for a workspace with no written conventions.
- **C4** dual expert — for frontend work where UI/UX quality is a hard requirement.

➡️ **Derived from Q2, not asked.** If your goal involves shipping interface
changes, C4. If it involves answering questions from your own material, C1. If
neither, A1. The recommendation names the configuration and the reason; changing
it is one word.

---

❓ **Q7** — **Jurisdiction for finance and tax roles**: Only asked if Q2 named
financial admin or tax filing. Determines which statutory framework applies.

➡️ **`MY` (Malaysia)**, matching the system default, configurable per workspace.
Note: the agent loads thresholds, rates, and deadlines from a **dated cited
source** at runtime and never from model recall — see
[`AGENT-ROLES.md` D10](AGENT-ROLES.md#d10--finance-administration-default-malaysia).
If you operate in more than one jurisdiction, say so; it changes the design from
one framework to several.

---

❓ **Q8** — **Design preference record**: Only asked if D5 or D6 is eligible.
Recorded once, applied consistently, and kept strictly separate from design
foundations — foundations are enforced, preferences are scored.

Four dimensions, and it is fine to say "no opinion" on any of them. That answer
is stored as a real preference state, not a gap:

- **Density** — `airy` (generous whitespace, low information per screen) · `compact` · `no opinion`
- **Contrast** — `high contrast, unmistakable affordances` · `soft, low-contrast surfaces` · `no opinion`
- **Tone** — `restrained and editorial` · `expressive and bold` · `no opinion`
- **Motion** — `minimal or none` · `animated and deliberate` · `no opinion`

➡️ Answer what's obvious and say `no opinion` for the rest. Fabricated
preferences produce confident work in a style you never wanted — a recorded
"no opinion" is more honest and more useful.

---

## Round 3 — Risk frontier

---

❓ **Q9** — **Escalation thresholds**: `if (confidence < τ) escalate`. What τ
should trigger a human?

Four classes, each with a threshold:

| Class | Meaning | τ range |
|---|---|---|
| `reversible_internal` | workspace-local, undoable | 0.45 – 0.55 |
| `external_visible` | leaves the machine, user sees it | 0.70 – 0.80 |
| `irreversible` | cannot be undone | 0.85 – 0.92 |
| `regulated` | financial, statutory, legal | 0.90 – 0.97 |

➡️ `0.50 / 0.75 / 0.88 / 0.95`. Higher is more autonomous and cheaper; lower is
safer and noisier. These are starting values to be tuned against observed
outcomes — the intake records them so the first tuning session has data.

---

❓ **Q10** — **High-risk roles**: Explicit accept or decline, each one, with the
precondition stated plainly:

- **D4 marketing** — drives a logged-in browser session with your social accounts.
  Ships draft-only. Browser access is a separate opt-in at the time of use.
- **D10 finance** — draft-only. No payment, no statutory submission, ever, under
  any threshold or configuration.
- **D11 tax filing** — prepares a review pack for a licensed human. **Requires a
  named reviewer before it is offered at all.**
- **D12 tool fetch** — installing executable code from the `agent-kd-skill`
  registry, which is treated as untrusted.

➡️ **D10 and D12 yes; D4 draft-only; D11 only if you can name a reviewer.** If
you cannot name one, say so — that is a valid answer and the role simply will not
be proposed. It is a better outcome than a role that exists and gets used without
review.

---

❓ **Q11** — **Notification channels and critical class**: Only if D9 is eligible.
Two parts, and the second is the one that is usually skipped.

- **Channels**: `inline` · `desktop` · `email` · `sms` (per-category opt-in)
- **Critical class**: what bypasses the interruption gate and suppression? This
  **must be defined at event creation**, not inferred at send time — otherwise the
  bypass becomes a general escape hatch and the suppression system quietly stops
  working.

➡️ `inline` + `desktop` only, no SMS. Critical class should be a short explicit
list of event types, not a judgement — "the build is broken", "a payment failed",
"a credential expired". Anything requiring interpretation does not belong here.

---

❓ **Q12** — **Quota budget**: Roughly how many JEV calls per month do you expect
to make? This maps to a plan tier and, more usefully, reveals whether the proposed
agent set is affordable.

A swarm of *K* agents costs at least *K*+2 calls. A C4 dual-expert frontend change
costs roughly 4–6. A single routed request costs 2–3.

➡️ Answer with a rough number. If the proposed set would exceed it, the Fabricator
proposes which agents to defer rather than shipping something that will exhaust
mid-task. That conversation is much cheaper here than at the exhaustion point.

---

## Round 4 — The satisfaction gate

---

❓ **Q13** — **Review the inference before building**: The Fabricator reads back
the complete profile — job, goals, autonomy, workspace, thresholds, accepted
roles, consent record — and asks for a final correction pass. Everything derived is
labelled `stated` or `inferred`.

➡️ Correct anything wrong now. After this, the profile is persisted and every
agent derives from it, so a wrong inference propagates to every agent that
depends on it.

---

❓ **Q14** — **Are you satisfied?**: The gate. Nothing is created before this
passes.

```
Before I build anything — are you satisfied with this profile?

  Job           solo founder, B2B SaaS                    [inferred: technical]
  Goals         1. ship interface changes without context-switching
  Autonomy      supervised
  Workspace     ~/projects/atlas · Node + Postgres + React
  Thresholds    .50 / .75 / .88 / .95
  Roles         C4 dual expert, D12 router, D6 frontend
  Channels      inline, desktop · critical: build broken, payment failed

  Yes, build it     /     No, let me change something
```

➡️ Yes — once it reflects you. The whole point is that the proposal is *yours*;
if it needed several rounds to become recognisable, the earlier rounds were not
doing their job.

---

## The proposal

Only after the gate passes. A table, per your request — one row per role, with a
checkmark, the reason, and the gate status.

```
Based on your profile — here is what I suggest:

  ✓  C4   Dual expert: coding + frontend       ship interface changes without
       │                                        context-switching · hard gates on
       │                                        viewport + accessibility
       │                                        [JEV G3: minimal · no agent
       │                                        duplicates this coverage]
       │
  ✓  D6   Frontend developer                   implements C4's decisions
       │                                        [JEV G3: minimal]
       │
  ✓  D12  Tools router (always active)         connects each step to the right
                                                tool; fetches only when nothing
                                                local fits
                                                [JEV G3: minimal · fetch
                                                gated, project-scoped, pinned]
                                                [JEV G4: fetch OFF by default]

  ⬜  D7   Backend developer                     no backend workflow in your goals
  ⬜  D3   Technical writer                      not among your stated goals —
                                                add it any time with /Fabri-Jev
  ⬜  C1   Research                              no dual-fetch question stated
  ⬜  D4   Marketing automation                 declined — draft-only available
                                                if you want it
  ⬜  D10  Finance admin                        declined
  ⬜  D11  Tax filing                           BLOCKED — no named reviewer
                                                (hard gate, not a preference)

  Tier: local · your workspace, your token
  Est. monthly calls: ~180 of your ~500 budget
```

### Checkmark legend

| Mark | Meaning |
|---|---|
| **✓** | Recommended. Every agent maps to a stated goal, and removing it leaves that goal uncovered (JEV G3 passed). |
| **⚠** | Conditional. Available once a named precondition is met — the precondition is stated on the row. |
| **⬜** | Not proposed. The reason is given, so the omission is a decision you can revisit rather than a gap. |
| **⊘** | Blocked. A hard gate is unmet and the role is not offered at all. Distinct from ⬜, which is a choice. |

### The distinction that matters

**⬜ and ⊘ are not the same.** ⬜ means "not needed for what you asked for" — a
recommendation. ⊘ means "this cannot be safely offered" — a block. D11 appears as
⊘ rather than ⬜ because no reviewer exists, which is not the same as the user not
wanting tax help.

---

## From proposal to callable agents

Accepted rows become rows in `agents`, each exposed as an MCP tool.

```sql
CREATE TABLE agent (
  id             TEXT PRIMARY KEY,
  profile_id     TEXT NOT NULL REFERENCES profile(id),
  role_id        TEXT NOT NULL,          -- A1|B1|B2|C1..C4|D1..D12
  name           TEXT NOT NULL,
  tier           TEXT NOT NULL CHECK (tier IN ('local','hosted')),
  enabled        INTEGER NOT NULL DEFAULT 1,
  mcp_tool_name  TEXT NOT NULL,          -- agent_c4_dual_expert
  jev_wiring     TEXT NOT NULL,          -- JSON: which primitive for which decision
  thresholds     TEXT NOT NULL,          -- JSON: per-class τ
  consent        TEXT NOT NULL,          -- JSON: capabilities, channels, gates granted
  quota_budget   INTEGER,                -- optional per-agent ceiling
  tokens_used    INTEGER NOT NULL DEFAULT 0,   -- the "total contribution" figure
  calls_used     INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','degraded','exhausted','revoked','disabled')),
  last_used_at   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX agent_profile ON agent(profile_id, enabled);
```

**On `tier: hosted`.** The Fabricator **must refuse** to create hosted agents
until [`TYPESAFE-PERMISSION-REQUEST.md`](TYPESAFE-PERMISSION-REQUEST.md) is
answered. Refusing at creation is correct; creating and failing later is not. A
hosted tier needs *K* users' worth of API access acting on behalf of third
parties, which is precisely the use the Interface terms appear to exclude.

### The registry listing

Requested as part of `/Fabri-Jev` — every created agent with its role, creation
date, and total contribution:

```
  Role                      Created        Contribution
  C4  Dual expert           2026-10-04     42,180 tokens · 31 calls
  D6  Frontend developer     2026-10-04     18,940 tokens · 22 calls
  D12 Tools router           2026-10-04      6,205 tokens · 61 calls
                              ────────────────────────────────
                              total          67,325 tokens · 114 calls
```

Contribution is `tokens_used` — JEV's own reported `usage.input_tokens +
usage.output_tokens`, accumulated per agent. It is the honest measure of what an
agent contributed to your work, and it is what your quota is spent on.

---

## Handling the awkward answers

The interview will hit these. Each has a defined behaviour rather than an
improvised one.

| Situation | Fabricator behaviour |
|---|---|
| *"I don't know, build me whatever"* | Build the **smallest** set matching the stated job, present it, and say plainly that this is a starting point to be corrected. Never treat it as consent to a large roster. |
| *"Just the one thing I asked for"* | Honour it literally. Do not add adjacent capabilities. Note what was deliberately left out, in one line. |
| Answers contradict round 1 | Stop and surface the contradiction explicitly. Do not silently prefer the later answer. |
| A goal names something outside the catalogue | Say so, name the closest configuration, and ask whether that is close enough. Do not map it to a poor approximation without saying. |
| The user asks for a role that failed a hard gate | State the gate and what would satisfy it. Offer the safe subset. The gate is not negotiable in conversation. |
| User is in `delegated` and asks for `irreversible` actions unattended | The `regulated` and `irreversible` classes still require a threshold and still escalate below it. Autonomy changes τ, not whether escalation exists. |
| A scan finds something concerning | Report it as a finding. Do not fix it unasked, and do not use it to justify expanding scope. |

---

## Facts the Fabricator finds itself

Never asked. Dispatched to a sub-agent or a read-only scan.

| Fact | How |
|---|---|
| Languages, frameworks, versions | Workspace scan |
| Test framework and coverage setup | Workspace scan |
| Existing conventions and their file counts | Workspace scan, corroborated-count only |
| Project policy file, if one exists | Workspace scan |
| Installed programs satisfying declared capabilities | C2 detect-only probing, after consent |
| Available tools and versions for D12 routing | Installed-skill inventory |
| Statutory thresholds, rates, deadlines | Versioned dated source, cited at retrieval |
| Per-agent token usage to date | `agent.tokens_used` |

A rule worth stating: **a fact the machine can establish is not a question to
ask.** Asking a user to report their own stack degrades every large project and
is measurably worse than reading the workspace.

---

## Re-running intake

`/Fabri-Jev` is idempotent and additive, not destructive.

- **Amend** — the profile updates; only agents whose derived config changed are
  rebuilt. Token usage and creation dates survive.
- **Add** — new goals propose new agents; existing ones are untouched.
- **Narrow** — disabling an agent stops exposing its MCP tool. Its history stays.
- **Reset** — requires explicit confirmation, because it discards every threshold
  and consent the user has tuned. Usage history is retained regardless; the
  contribution listing should never go missing because a profile was rebuilt.

Every change writes an `intake_round` row. The user's consent record is the reason
the gates are trustworthy later, so it is kept even when the agents are not.

---

## Design notes

**Why four rounds and not a form.** Each round's answers determine which questions
are even askable. A form asks everything regardless, which means most questions
are irrelevant to most users and the relevant ones arrive too late to shape the
others.

**Why the echo-back after round 1.** Inferred signals — technical founder, Node
stack, comfortable with delegation — propagate into every agent built from the
profile. A wrong inference at round 1 is corrected in one sentence; discovered at
round 4, it means rebuilding everything.

**Why JEV G3 is expected to fire often.** The gate asks whether the proposed set
is *minimal*. An intake that proposes twenty agents and passes on the first
attempt has not been checked. The failure mode this guards against is more
damaging than a slow interview: an unused agent is a liability the user never
agreed to, and it keeps spending quota.

**Why the satisfaction gate is binary.** A hedged "does this look roughly right?"
is answerable with "yeah, I guess", which produces an unowned profile. "Are you
satisfied?" invites a real no.

**Why roles are `⬜` rather than absent.** A rejected role with a stated reason is
a decision the user can revisit. A role that simply isn't mentioned is a gap they
may never notice they have.