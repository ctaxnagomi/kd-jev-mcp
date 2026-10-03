-- OAuth 2.1 authorization server for KD JEV MCP.
--
-- The Worker is both the authorization server and the resource server -- there
-- is no external IdP. MCP hosts (Claude Code, ChatGPT, Cursor) discover the
-- endpoints from the two well-known documents, register dynamically via DCR,
-- and run an authorization-code flow with PKCE S256.
--
-- Identity is the holder's own `kdj_...` gateway token, not a second passkey
-- system. That is deliberate:
--
--   * the user already holds the credential, so there is nothing new to lose;
--   * the grant binds to `tokens.id`, so revoking a token in the admin
--     dashboard kills every OAuth session derived from it immediately;
--   * quota and attribution resolve identically whether the caller used a
--     pasted bearer token or an OAuth access token.
--
-- Only hashes are stored. Access tokens, refresh tokens and codes are all
-- written as SHA-256 hex, so a D1 dump yields no usable credential.

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id                  TEXT PRIMARY KEY,
  -- NULL for public clients, which is the norm for MCP desktop/CLI hosts:
  -- PKCE is what binds the code to the client that asked for it.
  client_secret_hash         TEXT,
  client_name                TEXT NOT NULL,
  -- JSON array. Exact string match on authorize; no prefix or wildcard
  -- matching, so a lookalike redirect cannot be registered.
  redirect_uris              TEXT NOT NULL,
  grant_types                TEXT NOT NULL,
  response_types             TEXT NOT NULL DEFAULT '["code"]',
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
  scope                      TEXT NOT NULL DEFAULT 'mcp',
  created_at                 INTEGER NOT NULL
);

-- One row per issued authorization code. `used` is flipped by a conditional
-- UPDATE at exchange time, which is the lock that prevents a replay racing the
-- first use.
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash             TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL,
  -- The `tokens` row this grant acts on behalf of.
  token_id              TEXT NOT NULL,
  email                 TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,
  scope                 TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256',
  resource              TEXT,
  expires_at            INTEGER NOT NULL,
  used                  INTEGER NOT NULL DEFAULT 0,
  created_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_expiry ON oauth_codes(expires_at);

-- Access and refresh tokens live in one row: a refresh rotates the pair by
-- revoking this row and inserting a new one, so `refresh_token_hash` here is
-- always the current one and never a dangling reference to a dead grant.
CREATE TABLE IF NOT EXISTS oauth_access_tokens (
  id                 TEXT PRIMARY KEY,
  token_hash         TEXT NOT NULL UNIQUE,
  client_id          TEXT NOT NULL,
  token_id           TEXT NOT NULL,
  email              TEXT NOT NULL,
  scope              TEXT NOT NULL,
  refresh_token_hash TEXT,
  resource           TEXT,
  expires_at         INTEGER NOT NULL,
  revoked            INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_token_id ON oauth_access_tokens(token_id);
CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_client_id ON oauth_access_tokens(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_access_tokens_refresh ON oauth_access_tokens(refresh_token_hash);