// KD JEV MCP
//
// An authenticated MCP gateway in front of the TypeSafe JEV System One API.
//
//   /mcp        stateless Streamable HTTP MCP  (choice · noul · score · reason · usage · help)
//   /api/*      REST mirror for curl and automation
//   /admin      token dashboard (ADMIN_PASSKEY)
//   /health     unauthenticated liveness
//
//   /authorize  /token  /register  /revoke        OAuth 2.1 authorization server
//   /.well-known/oauth-protected-resource[/*]
//   /.well-known/oauth-authorization-server[/*]
//
// Clients hold a `kdj_...` gateway token, or an OAuth access token bound to one.
// The shared JEV API key stays on the server and is injected per request, so a
// client can never read it, and a leaked credential is revocable in one row
// update.
//
// Quota is charged per *tool call*, not per HTTP request. MCP clients send
// `initialize` and `tools/list` on nearly every session; charging those would
// burn a user's allowance without ever reaching JEV.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

import type { Env, Question, TokenRow } from "./types";
import { extractToken, isAdmin, resolveCredential, type Credential } from "./auth";
import { gateRequest, usageSnapshot } from "./quota";
import {
  JevUpstreamError,
  buildChoice,
  buildNoul,
  buildScore,
  normalizeQuestions,
  normalizeResult,
  systemOne,
} from "./jev";
import { ADMIN_HTML } from "./admin";
import {
  handleAuthorizationServer,
  handleAuthorize,
  handleProtectedResource,
  handleRegister,
  handleRevoke,
  handleToken,
  revokeSessionsForToken,
  unauthorizedChallenge,
} from "./oauth";
import { auditRow, envInt, json, normalizeToken, now, randomToken, sha256, uuid } from "./util";

const SERVER_NAME = "kd-jev-mcp";
const SERVER_VERSION = "1.0.0";

const HELP = `KD JEV MCP - an authenticated gateway to the TypeSafe JEV (System One) reasoning API.

JEV answers structured questions instead of generating prose. Three primitives:

  choice  Which option applies?      -> one of your option labels
  noul    Is this true, and how sure? -> 0..1 probability
  score   How much, against a rubric? -> index into your levels

Tools
  choice    Pick the best option for a state. Give options as name -> criterion;
            a structured criterion {what, not_for, examples[]} separates
            neighbouring options far better than a bare string.
  noul      Judge a yes/no question and get a calibrated probability. Pass
            criteria {true, false} to sharpen the boundary.
  score     Rate a state against an ordered rubric, lowest first. Returns the
            index, the legend, and the probability mass per level.
  reason    Send many questions of mixed primitives in ONE round trip. The
            upstream API runs them in parallel, so this is cheaper and faster
            than calling choice/noul/score repeatedly. Prefer this for anything
            beyond a single question.
  usage     This token's remaining quota, burst headroom, and token spend.
  help      This text.

Every answer is normalised to {type, value, confidence, probabilities, legend, raw}
so a client can read one shape regardless of which primitive produced it.

Composition: ask several narrow questions, then combine the numbers in your own
code. Broad questions hide several judgements behind one answer.

Authentication is a bearer token. Quota is charged per tool call.`;

type ToolText = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(value: unknown): ToolText {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string): ToolText {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, x-api-key",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

/** JEV evaluates text, JSON objects, or arrays of text -- not images or audio. */
const StateSchema = z.union([z.string().max(64_000), z.record(z.any()), z.array(z.any())]);
const CriterionSchema = z.union([z.string(), z.record(z.any())]);
const InstructionsSchema = z.union([z.string(), z.record(z.any())]);

// --------------------------------------------------------------- tool glue

/**
 * Charge the caller's allowance, run one upstream JEV call, and record what it
 * actually cost.
 *
 * Every path that reaches JEV goes through here, so quota cannot be bypassed by
 * adding a tool. The master credential skips the gate entirely: it is the
 * operator's break-glass and is not one of the 100 metered seats.
 */
/**
 * Outcome of one gateway call.
 *
 * Returned as a discriminated union rather than pre-rendered MCP text so the
 * REST mirror can map a denial onto a real HTTP status. Rendering to text first
 * and parsing it back is how a 429 silently became a 500.
 */
type JevCall =
  | { ok: true; result: ReturnType<typeof normalizeResult> }
  | { ok: false; status: number; code: string; error: string };

async function callJev(
  env: Env,
  credential: Credential,
  ctx: ExecutionContext,
  tool: string,
  questions: Record<string, Question>,
  state: unknown,
  model?: string,
): Promise<JevCall> {
  if (credential.kind === "token") {
    const gate = await gateRequest(env, credential.token);
    if (!gate.allowed) return { ok: false, status: gate.status, code: gate.code, error: gate.error };
    credential = { kind: "token", token: gate.token };
  }

  const started = now();
  try {
    const raw = await systemOne(env, { state, questions, model });
    const result = normalizeResult(raw);
    ctx.waitUntil(
      env.DB.prepare(
        `INSERT INTO usage_events (token_id, email, tool, outcome, input_tokens, output_tokens, latency_ms, created_at)
         VALUES (?, ?, ?, 'ok', ?, ?, ?, ?)`,
      )
        .bind(
          credential.kind === "token" ? credential.token.id : "master",
          credential.kind === "token" ? credential.token.email : "master",
          tool,
          result.usage.input_tokens,
          result.usage.output_tokens,
          now() - started,
          started,
        )
        .run()
        .catch(() => undefined),
    );
    return { ok: true, result };
  } catch (err) {
    const message = err instanceof JevUpstreamError ? err.message : String(err);
    ctx.waitUntil(
      env.DB.prepare(
        `INSERT INTO usage_events (token_id, email, tool, outcome, latency_ms, error, created_at)
         VALUES (?, ?, ?, 'error', ?, ?, ?)`,
      )
        .bind(
          credential.kind === "token" ? credential.token.id : "master",
          credential.kind === "token" ? credential.token.email : "master",
          tool,
          now() - started,
          message.slice(0, 300),
          started,
        )
        .run()
        .catch(() => undefined),
    );
    // Surface the status class so a client can tell "your request was bad" from
    // "the upstream is unwell" and react differently.
    const status = err instanceof JevUpstreamError ? err.status : 500;
    return { ok: false, status, code: "upstream_error", error: message };
  }
}

/** Render a call outcome as MCP tool text. */
function toolText(outcome: JevCall): ToolText {
  if (!outcome.ok) return fail(`${outcome.error} [${outcome.code}]`);
  return ok(outcome.result);
}

function buildServer(env: Env, credential: Credential, ctx: ExecutionContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: HELP });

  server.registerTool(
    "choice",
    {
      title: "JEV choice",
      description:
        "Pick the single best option for a state. Options are name -> criterion; a structured criterion {what, not_for, examples} separates neighbouring options far better than a bare string.",
      inputSchema: {
        state: StateSchema.describe("The text, JSON object, or array of text to evaluate."),
        instructions: InstructionsSchema.describe("The question to ask, e.g. 'Which category best describes this?'"),
        options: z
          .record(CriterionSchema)
          .describe("At least 2 options. Each value is a criterion string or {what, not_for, examples[]}."),
        model: z.string().optional().describe("Override the configured JEV model alias."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        // Reads the caller's own state and calls the upstream JEV model. No
        // writes to the gateway's data, but it is not hermetic.
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async (args) => {
      try {
        return toolText(
          await callJev(env, credential, ctx, "choice", { answer: buildChoice(args.instructions, args.options) }, args.state, args.model as string | undefined),
        );
      } catch (err) {
        return fail(err instanceof JevUpstreamError ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "noul",
    {
      title: "JEV noul",
      description:
        "Answer a yes/no question with a calibrated 0..1 probability. Pass criteria {true, false} to make the boundary explicit.",
      inputSchema: {
        state: StateSchema.describe("The text, JSON object, or array of text to evaluate."),
        instructions: InstructionsSchema.describe("The yes/no question to ask."),
        criteria: z
          .record(CriterionSchema)
          .optional()
          .describe("Optional {true, false} criteria describing each side of the boundary."),
        model: z.string().optional().describe("Override the configured JEV model alias."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async (args) => {
      try {
        return toolText(
          await callJev(env, credential, ctx, "noul", { answer: buildNoul(args.instructions, args.criteria as any) }, args.state, args.model as string | undefined),
        );
      } catch (err) {
        return fail(err instanceof JevUpstreamError ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "score",
    {
      title: "JEV score",
      description:
        "Rate a state against an ordered rubric, lowest first. Returns the index, the legend mapping index to level, and the probability mass per level.",
      inputSchema: {
        state: StateSchema.describe("The text, JSON object, or array of text to evaluate."),
        instructions: InstructionsSchema.describe("What is being rated, e.g. 'How urgent is this request?'"),
        levels: z.array(z.string()).min(2).max(10).describe("Rubric levels, lowest first. e.g. ['calm','annoyed','furious']"),
        model: z.string().optional().describe("Override the configured JEV model alias."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async (args) => {
      try {
        return toolText(
          await callJev(env, credential, ctx, "score", { answer: buildScore(args.instructions, args.levels) }, args.state, args.model as string | undefined),
        );
      } catch (err) {
        return fail(err instanceof JevUpstreamError ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "reason",
    {
      title: "JEV batch reason",
      description:
        "Ask many questions of mixed primitives in ONE round trip. The upstream API evaluates them in parallel, so batching is cheaper and faster than repeated single calls. Use narrow, atomic questions and combine the results in your own code.",
      inputSchema: {
        state: StateSchema.describe("The shared state every question is evaluated against."),
        questions: z
          .record(
            z.object({
              type: z.enum(["choice", "noul", "score"]),
              instructions: InstructionsSchema,
              criteria: z.union([z.record(CriterionSchema), z.array(z.string())]).optional(),
            }),
          )
          .describe(
            "Keyed by question name. choice -> criteria is name->criterion; noul -> criteria is {true,false}; score -> criteria is an ordered array of levels.",
          ),
        model: z.string().optional().describe("Override the configured JEV model alias."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async (args) => {
      try {
        const questions = normalizeQuestions(args.questions as Record<string, any>);
        return toolText(
          await callJev(env, credential, ctx, "reason", questions, args.state, args.model as string | undefined),
        );
      } catch (err) {
        return fail(err instanceof JevUpstreamError ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    "usage",
    {
      title: "Token usage",
      description: "This token's remaining monthly quota, current burst headroom, and lifetime JEV token spend.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    },
    async () => {
      if (credential.kind === "master") return ok({ kind: "master", note: "master credential is not metered" });
      try {
        return ok(await usageSnapshot(env, credential.token));
      } catch (err) {
        return fail(String(err));
      }
    },
  );

  server.registerTool(
    "help",
    { title: "Help", description: "How to use KD JEV MCP, and when to prefer `reason` over the single primitives.", inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true } },
    async () => ok({ help: HELP }),
  );

  return server;
}

async function handleMcp(
  request: Request,
  env: Env,
  credential: Credential,
  ctx: ExecutionContext,
): Promise<Response> {
  const server = buildServer(env, credential, ctx);
  // sessionIdGenerator: undefined -> stateless. Each request builds its own
  // server, which is what a Workers isolate allows without Durable Objects.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await server.close().catch(() => undefined);
  }
}

// ------------------------------------------------------------------- admin

/** Admin passkey from a header or the JSON body. Never accepted in the query string. */
function adminPasskey(request: Request, body?: Record<string, any>): string {
  return request.headers.get("x-admin-passkey") || body?.passkey || "";
}

function adminJson(result: Record<string, any>): Response {
  const status = result?.error === "unauthorized" ? 401 : 200;
  return json(result, { status, headers: CORS });
}

async function listTokens(env: Env, passkey: string, request: Request): Promise<Record<string, any>> {
  if (!isAdmin(env, passkey)) {
    ctxlessAudit(env, request, "admin_login_fail", "failed token list attempt");
    return { error: "unauthorized" };
  }
  ctxlessAudit(env, request, "admin_login", "viewed token list");

  const maxUsers = envInt(env, "MAX_USERS", 100);
  const { results } = await env.DB.prepare(
    `SELECT email, label, status, quota_monthly, requests_used, requests_reset_at,
            rate_limit_per_min, last_used_at, created_at
       FROM tokens ORDER BY created_at DESC LIMIT 500`,
  )
    .bind()
    .all<Record<string, any>>();

  const tokens = results || [];
  const active = tokens.filter((t) => t.status === "active").length;

  // 30-day usage rollup. Kept in one query so the dashboard is a single round
  // trip rather than one per stat card.
  const usage = await env.DB.prepare(
    `SELECT COUNT(*) AS calls_30d, COALESCE(SUM(input_tokens),0) AS in_30d, COALESCE(SUM(output_tokens),0) AS out_30d
       FROM usage_events WHERE created_at >= ?`,
  )
    .bind(now() - 30 * 86_400_000)
    .first<{ calls_30d: number; in_30d: number; out_30d: number }>();

  return {
    tokens,
    stats: {
      total: tokens.length,
      active,
      disabled: tokens.length - active,
      max_users: maxUsers,
      seats_left: Math.max(0, maxUsers - active),
      calls_30d: usage?.calls_30d ?? 0,
      jev_tokens_30d: (usage?.in_30d ?? 0) + (usage?.out_30d ?? 0),
    },
  };
}

/**
 * Live OAuth sessions, newest first.
 *
 * Surfaced in the dashboard so an operator can see which third-party apps hold a
 * standing grant against a token -- the thing that makes "revoke this token"
 * auditable rather than a leap of faith.
 */
async function listGrants(env: Env, passkey: string): Promise<Record<string, any>> {
  if (!isAdmin(env, passkey)) return { error: "unauthorized" };

  const { results } = await env.DB.prepare(
    `SELECT o.id, o.client_id, o.token_id, o.email, o.scope, o.expires_at, o.revoked, o.created_at,
            c.client_name,
            (SELECT MAX(created_at) FROM usage_events u WHERE u.token_id = o.token_id) AS last_call_at
       FROM oauth_access_tokens o
       LEFT JOIN oauth_clients c ON c.client_id = o.client_id
      ORDER BY o.created_at DESC
      LIMIT 200`,
  )
    .bind()
    .all<Record<string, any>>();

  const grants = results || [];
  return {
    grants: grants.map((g) => ({
      ...g,
      live: !g.revoked && g.expires_at > now(),
    })),
    active: grants.filter((g) => !g.revoked && g.expires_at > now()).length,
  };
}

/** Best-effort audit write for admin reads, which have no ExecutionContext. */
function ctxlessAudit(env: Env, request: Request, action: string, detail: string): void {
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "";
  const agent = (request.headers.get("user-agent") || "").slice(0, 200);
  env.DB.prepare(
    "INSERT INTO audit_logs (actor, action, detail, ip, user_agent, created_at) VALUES ('admin', ?, ?, ?, ?, ?)",
  )
    .bind(action, detail, ip, agent, now())
    .run()
    .catch(() => undefined);
}

/**
 * Token issuance and lifecycle.
 *
 * Actions: create · rotate · revoke · enable · update
 *
 * `create` and `rotate` return the plaintext token exactly once. It is never
 * stored -- only its SHA-256 hash -- so there is deliberately no "show me the
 * token again" path. Losing it means rotating, which is the intended trade.
 */
async function adminTokensAction(
  env: Env,
  body: Record<string, any>,
  passkey: string,
  request: Request,
): Promise<Record<string, any>> {
  if (!isAdmin(env, passkey)) {
    ctxlessAudit(env, request, "admin_login_fail", `failed ${body?.action || "?"} attempt`);
    return { error: "unauthorized" };
  }

  const action = String(body.action || "create");
  const email = String(body.email || "").trim().toLowerCase();
  const t = now();

  if (action === "create" || action === "rotate") {
    if (!email || email.length < 3 || !email.includes("@")) return { error: "a valid email is required" };

    const existing = await env.DB.prepare(
      "SELECT id, status, quota_monthly, rate_limit_per_min FROM tokens WHERE email = ?",
    )
      .bind(email)
      .first<{ id: string; status: string; quota_monthly: number; rate_limit_per_min: number }>();

    // Re-issuing for an existing holder does not consume a new seat, so the cap
    // only applies when a genuinely new person is added.
    if (!existing) {
      const maxUsers = envInt(env, "MAX_USERS", 100);
      const count = await env.DB.prepare("SELECT COUNT(*) AS c FROM tokens WHERE status = 'active'")
        .bind()
        .first<{ c: number }>();
      if ((count?.c ?? 0) >= maxUsers) {
        return {
          error: `seat limit reached (${maxUsers}/${maxUsers}). Revoke a token before adding another.`,
        };
      }
    }

    // A rotation replaces the secret, not the holder's allowance. Falling back to
    // the server default would silently reset someone's quota at the exact
    // moment they lost a token, so an existing row supplies the fallback.
    const fallbackQuota = existing?.quota_monthly ?? envInt(env, "DEFAULT_QUOTA_MONTHLY", 1000);
    const fallbackRate = existing?.rate_limit_per_min ?? envInt(env, "DEFAULT_RATE_PER_MIN", 60);

    const quota = Number.isFinite(Number(body.quota_monthly)) && Number(body.quota_monthly) > 0
      ? Math.min(1_000_000, Math.floor(Number(body.quota_monthly)))
      : fallbackQuota;
    const rate = Number.isFinite(Number(body.rate_limit_per_min)) && Number(body.rate_limit_per_min) > 0
      ? Math.min(10_000, Math.floor(Number(body.rate_limit_per_min)))
      : fallbackRate;
    const label = body.label ? String(body.label).slice(0, 80) : null;

    const token = randomToken();
    const hash = await sha256(normalizeToken(token));
    const periodMs = envInt(env, "QUOTA_PERIOD_DAYS", 30) * 86_400_000;

    if (existing) {
      // Rotation resets the meter: the new holder starts from a clean window
      // rather than inheriting the previous one's usage.
      await env.DB.prepare(
        `UPDATE tokens
            SET token_hash = ?, status = 'active', label = COALESCE(?, label),
                quota_monthly = ?, rate_limit_per_min = ?,
                requests_used = 0, requests_reset_at = ?,
                rate_window = 0, rate_count = 0, updated_at = ?
          WHERE id = ?`,
      )
        .bind(hash, label, quota, rate, t + periodMs, t, existing.id)
        .run();
    } else {
      await env.DB.prepare(
        `INSERT INTO tokens
           (id, email, label, token_hash, status, quota_monthly, requests_used, requests_reset_at,
            rate_limit_per_min, rate_window, rate_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, 0, ?, ?, 0, 0, ?, ?)`,
      )
        .bind(uuid(), email, label, hash, quota, t + periodMs, rate, t, t)
        .run();
    }

    await auditRow(env, "admin", action === "create" ? "token_created" : "token_rotated", email, request)
      .run()
      .catch(() => undefined);

    return { ok: true, action, email, token, quota_monthly: quota, rate_limit_per_min: rate, label };
  }

  if (action === "revoke" || action === "enable") {
    if (!email) return { error: "email is required" };
    const status = action === "revoke" ? "disabled" : "active";
    const res = await env.DB.prepare("UPDATE tokens SET status = ?, updated_at = ? WHERE email = ?")
      .bind(status, t, email)
      .run();
    if (!res.meta?.changes) return { error: `no token found for ${email}` };

    // Revoking the token must also kill every OAuth session derived from it.
    // Otherwise a compromised token keeps working for up to an hour through a
    // connector, which is the whole incident rather than a mitigation of it.
    if (action === "revoke") {
      const row = await env.DB.prepare("SELECT id FROM tokens WHERE email = ?").bind(email).first<{ id: string }>();
      if (row) await revokeSessionsForToken(env, row.id);
    }

    await auditRow(env, "admin", `token_${status}`, email, request).run().catch(() => undefined);
    return { ok: true, action, email, status };
  }

  if (action === "update") {
    if (!email) return { error: "email is required" };
    const sets: string[] = [];
    const binds: any[] = [];
    if (body.quota_monthly !== undefined) {
      const q = Number(body.quota_monthly);
      if (!Number.isFinite(q) || q < 0) return { error: "quota_monthly must be a non-negative number" };
      sets.push("quota_monthly = ?");
      binds.push(Math.floor(q));
    }
    if (body.rate_limit_per_min !== undefined) {
      const r = Number(body.rate_limit_per_min);
      if (!Number.isFinite(r) || r < 0) return { error: "rate_limit_per_min must be a non-negative number" };
      sets.push("rate_limit_per_min = ?");
      binds.push(Math.floor(r));
    }
    if (body.label !== undefined) {
      sets.push("label = ?");
      binds.push(body.label ? String(body.label).slice(0, 80) : null);
    }
    if (!sets.length) return { error: "nothing to update" };
    sets.push("updated_at = ?");
    binds.push(t, email);
    const res = await env.DB.prepare(`UPDATE tokens SET ${sets.join(", ")} WHERE email = ?`).bind(...binds).run();
    if (!res.meta?.changes) return { error: `no token found for ${email}` };
    await auditRow(env, "admin", "token_updated", email, request).run().catch(() => undefined);
    return { ok: true, action, email };
  }

  return { error: `unknown action "${action}"` };
}

async function adminAudit(env: Env, passkey: string, url: URL, request: Request): Promise<Record<string, any>> {
  if (!isAdmin(env, passkey)) {
    ctxlessAudit(env, request, "admin_login_fail", "failed audit read attempt");
    return { error: "unauthorized" };
  }
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
  const { results } = await env.DB.prepare(
    "SELECT actor, action, detail, ip, created_at FROM audit_logs ORDER BY created_at DESC LIMIT ?",
  )
    .bind(limit)
    .all<Record<string, any>>();
  return { logs: results || [] };
}

// --------------------------------------------------------------------- REST

/**
 * REST mirror of the MCP tools, for curl and automation.
 * Same gate, same normalisation, same upstream call.
 */
async function handleRest(
  request: Request,
  env: Env,
  path: string,
  credential: Credential,
  ctx: ExecutionContext,
): Promise<Response> {
  const body =
    request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, any>) : {};

  // Build the call first, so a validation error and a gate denial surface as
  // the right HTTP status rather than a blanket 500.
  let call: Promise<JevCall>;
  try {
    switch (path) {
      case "/api/choice":
        call = callJev(env, credential, ctx, "choice", { answer: buildChoice(body.instructions, body.options) }, body.state, body.model);
        break;
      case "/api/noul":
        call = callJev(env, credential, ctx, "noul", { answer: buildNoul(body.instructions, body.criteria) }, body.state, body.model);
        break;
      case "/api/score":
        call = callJev(env, credential, ctx, "score", { answer: buildScore(body.instructions, body.levels) }, body.state, body.model);
        break;
      case "/api/reason":
        call = callJev(env, credential, ctx, "reason", normalizeQuestions(body.questions ?? {}), body.state, body.model);
        break;
      case "/api/usage":
        if (credential.kind !== "token") return json({ kind: "master", note: "master credential is not metered" }, { headers: CORS });
        return json(await usageSnapshot(env, credential.token), { headers: CORS });
      case "/api/whoami":
        if (credential.kind !== "token") return json({ kind: "master" }, { headers: CORS });
        return json(
          {
            email: credential.token.email,
            label: credential.token.label,
            status: credential.token.status,
            // How this caller authenticated. An OAuth session is reported with
            // the app it belongs to, so a user can tell a connector apart from a
            // pasted token when they look at their own access.
            authenticated_via: credential.oauth ? "oauth" : "api_token",
            client: credential.oauth
              ? { name: credential.oauth.clientName, client_id: credential.oauth.clientId }
              : null,
            access_token_expires_at: credential.oauth?.expiresAt ?? null,
          },
          { headers: CORS },
        );
      default:
        return json({ error: "not found" }, { status: 404, headers: CORS });
    }
  } catch (err) {
    // Only question validation throws synchronously; upstream failures arrive
    // through the awaited outcome below.
    const status = err instanceof JevUpstreamError ? err.status : 500;
    return json({ error: err instanceof Error ? err.message : String(err), code: "invalid_request" }, { status, headers: CORS });
  }

  const outcome = await call;
  if (!outcome.ok) {
    return json(
      { error: outcome.error, code: outcome.code },
      {
        status: outcome.status,
        headers: outcome.code === "rate_limited" ? { ...CORS, "retry-after": String(outcome.status === 429 ? 60 : 0) } : CORS,
      },
    );
  }
  return json(outcome.result, { headers: CORS });
}

// -------------------------------------------------------------------- routes

const LANDING = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>KD JEV MCP</title>
<style>body{background:#0a0a0a;color:#fff;font-family:ui-sans-serif,-apple-system,'Segoe UI',Roboto,sans-serif;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
.c{max-width:620px}h1{font-size:26px;letter-spacing:-.02em}p{color:#a1a1a6;line-height:1.65;font-size:14px}
code{background:#16181c;border:1px solid #262a30;padding:2px 6px;border-radius:4px;font-size:12px;color:#00f0ff}
a{color:#00f0ff}</style></head><body><div class="c">
<h1>KD JEV MCP</h1>
<p>An authenticated MCP gateway to the TypeSafe <strong>JEV / System One</strong> reasoning API.
Structured decisions &mdash; <code>choice</code>, <code>noul</code>, <code>score</code> &mdash; behind per-user tokens,
quotas and an audit trail.</p>
<p>Endpoints: <code>/mcp</code> (Streamable HTTP MCP) &middot; <code>/api/*</code> (REST) &middot; <code>/health</code><br>
Operator: <a href="/admin">/admin</a></p>
</div></body></html>`;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (path === "/health") {
      // Unauthenticated on purpose: a gateway that cannot answer "are you up?"
      // is hard to operate. Reveals no secret and touches no user data.
      const configured = Boolean(env.JEV_API_KEY);
      const db = await env.DB.prepare("SELECT 1 AS ok").first().catch(() => null);
      return json(
        {
          status: db ? (configured ? "ok" : "degraded") : "down",
          jev_key_configured: configured,
          database: db ? "reachable" : "unreachable",
          uptime_note: "requests are stateless; there is no session state to report",
        },
        { headers: CORS },
      );
    }

    if (path === "/" || path === "/index.html") {
      return new Response(LANDING, { headers: { "content-type": "text/html;charset=UTF-8" } });
    }

    if (path === "/admin") {
      return new Response(ADMIN_HTML, {
        headers: { "content-type": "text/html;charset=UTF-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
      });
    }

    // ---------------------------------------------------------- OAuth 2.1 AS
    //
    // Discovery documents are public and cached. The AS routes sit ahead of the
    // data plane so a client that has only been told the worker's origin can
    // walk itself from /.well-known through to a working token.
    if (path === "/register") return handleRegister(env, request);
    if (path === "/authorize") return handleAuthorize(env, request);
    if (path === "/token") return handleToken(env, request);
    if (path === "/revoke") return handleRevoke(env, request);
    if (path === "/.well-known/oauth-protected-resource" || path.startsWith("/.well-known/oauth-protected-resource/")) {
      return handleProtectedResource(request);
    }
    if (path === "/.well-known/oauth-authorization-server" || path.startsWith("/.well-known/oauth-authorization-server/")) {
      return handleAuthorizationServer(request);
    }

    // ---------------------------------------------------------------- admin API
    if (path === "/api/admin/tokens" || path === "/api/admin/audit" || path === "/api/admin/grants") {
      const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, any>) : {};
      const passkey = adminPasskey(request, body);
      if (path === "/api/admin/tokens" && request.method === "POST") {
        return adminJson(await adminTokensAction(env, body, passkey, request));
      }
      return adminJson(
        path === "/api/admin/tokens"
          ? await listTokens(env, passkey, request)
          : path === "/api/admin/grants"
            ? await listGrants(env, passkey)
            : await adminAudit(env, passkey, url, request),
      );
    }

    // --------------------------------------------------------------- data plane
    if (path === "/mcp" || path.startsWith("/api/")) {
      const credential = await resolveCredential(env, request);
      if (!credential) {
        // No token presented at all vs. a token we rejected are the same
        // problem to a caller, and distinguishing them would confirm that a
        // guessed token once existed.
        //
        // /mcp answers with the RFC 9724 challenge so an MCP host can discover
        // the authorization server and start a consent flow on its own. /api/*
        // keeps the plain Bearer challenge, because curl users do not need a
        // browser round trip to fix a header.
        if (path === "/mcp") return unauthorizedChallenge(request);
        return json(
          { error: "unauthorized", hint: "send Authorization: Bearer kdj_... (generate one at /admin)" },
          { status: 401, headers: { ...CORS, "www-authenticate": "Bearer" } },
        );
      }
      if (path === "/mcp") return handleMcp(request, env, credential, ctx);
      return handleRest(request, env, path, credential, ctx);
    }

    return json({ error: "not found" }, { status: 404, headers: CORS });
  },
};