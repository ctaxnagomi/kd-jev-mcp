export interface Env {
  DB: D1Database;

  /** Shared upstream credential. Injected by the proxy, never returned to a client. */
  JEV_API_KEY?: string;
  JEV_ENDPOINT: string;
  JEV_MODEL: string;

  /** Break-glass credential that bypasses D1 entirely. Set as a secret. */
  MCP_TOKEN?: string;

  /** Admin passkey for /admin and /api/admin/*. Set as a secret. */
  ADMIN_PASSKEY?: string;

  MAX_USERS: string;
  DEFAULT_QUOTA_MONTHLY: string;
  DEFAULT_RATE_PER_MIN: string;
  QUOTA_PERIOD_DAYS: string;

  /**
   * Recurring KD Credit allowance handed to a new seat, in whole credits.
   * Optional -- falls back to `credit_settings.default_credits` when unset, and
   * to the server default when that row is missing too.
   */
  DEFAULT_CREDITS?: string;
}

export type TokenStatus = "active" | "disabled";

export interface TokenRow {
  id: string;
  email: string;
  label: string | null;
  token_hash: string;
  status: TokenStatus;
  quota_monthly: number;
  requests_used: number;
  requests_reset_at: number | null;
  rate_limit_per_min: number;
  rate_window: number;
  rate_count: number;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;

  // ----------------------------------------------------------- credit balance
  // All in MICRO-credits (1 KD Credit = 1,000,000). Split into a recurring grant
  // that resets with the window and a top-up that never does, so a top-up
  // cannot be silently eaten by the next reset.
  credits_granted: number;
  credits_used: number;
  credits_extra: number;

  /** Lifetime JEV input+output tokens. Admin-only; reconciles against the invoice. */
  jev_tokens_lifetime: number;
}

/** How a caller proved who they are. Surfaced by `whoami` and the audit log. */
export type CredentialKind = "master" | "token" | "oauth";

export interface OAuthGrantInfo {
  clientId: string;
  clientName: string;
  expiresAt: number;
}

/** The three System One primitives. These names are the whole product. */
export type Primitive = "choice" | "noul" | "score";

/**
 * Structured criteria are supported by the upstream API and are strongly
 * encouraged: for a Choice, `what` / `not_for` / `examples` per option is what
 * makes two neighbouring options distinguishable. A bare string stays legal.
 */
export type CriterionValue = string | Record<string, unknown>;
export type Instructions = string | Record<string, unknown>;

export interface ChoiceQuestion {
  type: "choice";
  instructions: Instructions;
  criteria: Record<string, CriterionValue>;
}

export interface NoulQuestion {
  type: "noul";
  instructions: Instructions;
  criteria?: Record<string, CriterionValue>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: Instructions;
  /** Ordered levels, lowest first. Index is the value the model scores against. */
  criteria: string[];
}

export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion;

export interface SystemOneRequest {
  state: unknown;
  questions: Record<string, Question>;
  model?: string;
}

export interface SystemOneResponse {
  model?: string;
  answers?: Record<string, any>;
  usage?: { input_tokens?: number; output_tokens?: number };
  request_id?: string;
  evaluation_time_ms?: number;
}