// Upstream JEV (TypeSafe System One) proxy.
//
// This is the only place that touches the shared JEV API key. Clients never
// hold it: they hold a `kdj_...` gateway token, and this module injects the
// upstream credential on their behalf.
//
// Three primitives, all available in a single call:
//
//   choice -> which option applies        -> string label
//   noul   -> is this true, and how sure  -> 0..1 probability
//   score  -> how much, against a rubric  -> index into the rubric
//
// The upstream API deliberately accepts *many* questions per request and runs
// them in parallel. `reason` forwards a whole batch in one round trip, which is
// both cheaper and faster than one call per question.

import type {
  ChoiceQuestion,
  CriterionValue,
  Env,
  Instructions,
  NoulQuestion,
  Question,
  ScoreQuestion,
  SystemOneRequest,
  SystemOneResponse,
} from "./types";

/** Cost control. JEV bills per question, so the batch size is the spend lever. */
const MAX_QUESTIONS = 25;
const MAX_STATE_CHARS = 64_000;

export class JevUpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "JevUpstreamError";
  }
}

/**
 * Call System One.
 *
 * Throws JevUpstreamError on any non-2xx so callers can distinguish an upstream
 * failure (502 to the client) from a bad request of their own (400).
 *
 * The API key is only ever read here, and never echoed into an error message:
 * upstream error bodies are truncated and forwarded verbatim, so if TypeSafe
 * ever quoted the request back at us the key would otherwise leak to whoever
 * holds the bad token.
 */
export async function systemOne(env: Env, req: SystemOneRequest): Promise<SystemOneResponse> {
  const apiKey = env.JEV_API_KEY;
  if (!apiKey) {
    throw new JevUpstreamError(
      "JEV_API_KEY is not configured on this Worker. Set it with `wrangler secret put JEV_API_KEY`.",
      503,
    );
  }

  const questionNames = Object.keys(req.questions ?? {});
  if (questionNames.length === 0) {
    throw new JevUpstreamError("at least one question is required", 400);
  }
  if (questionNames.length > MAX_QUESTIONS) {
    throw new JevUpstreamError(
      `too many questions: ${questionNames.length} (max ${MAX_QUESTIONS}). Split the batch.`,
      400,
    );
  }

  const serializedState = JSON.stringify(req.state ?? null) ?? "null";
  if (serializedState.length > MAX_STATE_CHARS) {
    throw new JevUpstreamError(
      `state is too large: ${serializedState.length} chars (max ${MAX_STATE_CHARS}). Send only relevant context.`,
      400,
    );
  }

  const base = (env.JEV_ENDPOINT || "https://api.typesafe.ai").replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/v1/systemone`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        state: req.state,
        model: req.model || env.JEV_MODEL || "jev-latest",
        questions: req.questions,
      }),
    });
  } catch (err) {
    throw new JevUpstreamError(`could not reach JEV upstream: ${String(err)}`, 502);
  }

  if (!res.ok) {
    // Redact anything that looks like the key before surfacing upstream text.
    const raw = (await res.text().catch(() => "")).slice(0, 400);
    const safe = apiKey ? raw.split(apiKey).join("[redacted]") : raw;
    throw new JevUpstreamError(`JEV upstream ${res.status}: ${safe}`, res.status >= 500 ? 502 : 400);
  }

  let parsed: SystemOneResponse;
  try {
    parsed = (await res.json()) as SystemOneResponse;
  } catch {
    throw new JevUpstreamError("JEV upstream returned a non-JSON body", 502);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new JevUpstreamError("JEV upstream returned an unexpected body", 502);
  }
  return parsed;
}

// ------------------------------------------------------------ normalising

export interface NormalizedAnswer {
  type: string;
  /** choice -> option label, noul -> 0..1, score -> rubric index. null if absent. */
  value: string | number | null;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  /** For scores, maps index -> the level string the caller supplied. */
  legend: Record<string, string> | null;
  raw: unknown;
}

/**
 * Flatten the upstream answer envelope into one predictable shape.
 *
 * The API returns each answer as `{type, choice|noul|score, confidence,
 * probabilities, legend}` where `confidence` and `probabilities` are optional
 * and depend on the primitive and the model. Clients would otherwise have to
 * branch on which key is present for every question. Keeping `raw` alongside
 * means no information is lost for anyone who needs the exact upstream shape.
 */
export function normalizeAnswer(raw: unknown): NormalizedAnswer {
  const a = (raw ?? {}) as Record<string, any>;
  const type = typeof a.type === "string" ? a.type : "unknown";

  let value: string | number | null = null;
  if (typeof a.choice === "string") value = a.choice;
  else if (typeof a.noul === "number") value = a.noul;
  else if (typeof a.score === "number") value = a.score;

  return {
    type,
    value,
    confidence: typeof a.confidence === "number" ? a.confidence : null,
    probabilities:
      a.probabilities && typeof a.probabilities === "object" ? (a.probabilities as Record<string, number>) : null,
    legend: a.legend && typeof a.legend === "object" ? (a.legend as Record<string, string>) : null,
    raw,
  };
}

export interface NormalizedResult {
  model: string | null;
  answers: Record<string, NormalizedAnswer>;
  usage: { input_tokens: number | null; output_tokens: number | null };
  request_id: string | null;
  evaluation_time_ms: number | null;
}

export function normalizeResult(res: SystemOneResponse): NormalizedResult {
  const answers: Record<string, NormalizedAnswer> = {};
  for (const [name, value] of Object.entries(res.answers ?? {})) {
    answers[name] = normalizeAnswer(value);
  }
  return {
    model: res.model ?? null,
    answers,
    usage: {
      input_tokens: res.usage?.input_tokens ?? null,
      output_tokens: res.usage?.output_tokens ?? null,
    },
    request_id: res.request_id ?? null,
    evaluation_time_ms: res.evaluation_time_ms ?? null,
  };
}

// ------------------------------------------------------- question builders

function checkInstructions(instructions: Instructions): void {
  if (typeof instructions === "string") {
    if (!instructions.trim()) throw new JevUpstreamError("instructions must not be empty", 400);
    return;
  }
  if (instructions && typeof instructions === "object") return;
  throw new JevUpstreamError("instructions must be a string or an object", 400);
}

export function buildChoice(
  instructions: Instructions,
  options: Record<string, CriterionValue>,
): ChoiceQuestion {
  const names = Object.keys(options ?? {});
  if (names.length < 2) {
    throw new JevUpstreamError("choice requires at least 2 options", 400);
  }
  if (names.length > 20) {
    throw new JevUpstreamError(`choice supports at most 20 options (got ${names.length})`, 400);
  }
  checkInstructions(instructions);
  return { type: "choice", instructions, criteria: options };
}

export function buildNoul(instructions: Instructions, criteria?: Record<string, CriterionValue>): NoulQuestion {
  checkInstructions(instructions);
  if (criteria !== undefined) {
    if (!criteria || typeof criteria !== "object" || Object.keys(criteria).length === 0) {
      throw new JevUpstreamError("noul criteria must be a non-empty object", 400);
    }
  }
  return criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions };
}

export function buildScore(instructions: Instructions, levels: string[]): ScoreQuestion {
  checkInstructions(instructions);
  if (!Array.isArray(levels) || levels.length < 2) {
    throw new JevUpstreamError("score requires at least 2 rubric levels, lowest first", 400);
  }
  if (levels.length > 10) {
    throw new JevUpstreamError(`score supports at most 10 levels (got ${levels.length})`, 400);
  }
  if (levels.some((l) => typeof l !== "string" || !l.trim())) {
    throw new JevUpstreamError("every score level must be a non-empty string", 400);
  }
  return { type: "score", instructions, criteria: levels };
}

/** Validate a caller-supplied batch of questions for the `reason` tool. */
export function normalizeQuestions(input: Record<string, any>): Record<string, Question> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new JevUpstreamError("questions must be an object keyed by question name", 400);
  }
  const out: Record<string, Question> = {};
  for (const [name, spec] of Object.entries(input)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) {
      throw new JevUpstreamError(
        `invalid question name "${name}": must start with a letter, then letters/digits/underscore (max 64)`,
        400,
      );
    }
    if (!spec || typeof spec !== "object") {
      throw new JevUpstreamError(`question "${name}" must be an object`, 400);
    }
    const instructions = (spec as any).instructions;
    switch ((spec as any).type) {
      case "choice":
        out[name] = buildChoice(instructions, (spec as any).criteria ?? (spec as any).options ?? {});
        break;
      case "noul":
        out[name] = buildNoul(instructions, (spec as any).criteria);
        break;
      case "score":
        out[name] = buildScore(instructions, (spec as any).criteria ?? (spec as any).levels ?? []);
        break;
      default:
        throw new JevUpstreamError(`question "${name}" has unknown type "${(spec as any).type}"`, 400);
    }
  }
  return out;
}