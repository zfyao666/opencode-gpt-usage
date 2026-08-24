import { readFile } from "node:fs/promises"

/**
 * Codex CLI credentials file (`~/.codex/auth.json`).
 * Only `tokens` are used; everything else is ignored.
 */
export type CodexAuth = {
  tokens?: {
    access_token?: string
    id_token?: string
    account_id?: string
  }
}

/** Read and parse the Codex CLI auth file. Returns null on any failure. */
export async function readCodexAuth(path: string): Promise<CodexAuth | null> {
  try {
    const raw = await readFile(path, "utf8")
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return parsed as CodexAuth
  } catch {
    return null
  }
}

export type AccessCredentials = {
  accessToken: string
  accountId?: string
}

/**
 * Pick usable credentials for the wham usage endpoint.
 *
 * Deliberately NOT gated on id_token expiry: the id_token and access_token
 * have independent lifetimes, and the usage endpoint only needs a valid
 * access token. If the access token is genuinely stale, the endpoint answers
 * 401 and we surface the auth state (`codex login`) — we never invent an
 * OAuth refresh flow.
 */
export function getAccessCredentials(auth: CodexAuth | null): AccessCredentials | null {
  const tokens = auth?.tokens
  if (!tokens) return null
  const token = tokens.access_token
  if (typeof token !== "string" || token.length === 0) return null
  const accountId = tokens.account_id
  return {
    accessToken: token,
    accountId: typeof accountId === "string" && accountId.length > 0 ? accountId : undefined,
  }
}
