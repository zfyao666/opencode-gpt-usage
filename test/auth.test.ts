import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getAccessCredentials, readCodexAuth } from "../src/auth"

describe("getAccessCredentials", () => {
  test("expired id_token with valid access_token still yields credentials", () => {
    // id_token exp = Jan 2023 (long expired); access_token is what matters.
    const auth = {
      tokens: {
        access_token: "at-still-valid",
        id_token: "eyJhbGciOiJub25lIn0.eyJleHAiOjE2NzI1MzQ0MDB9.",
        account_id: "acc-42",
      },
    }
    const creds = getAccessCredentials(auth)
    expect(creds).not.toBeNull()
    expect(creds?.accessToken).toBe("at-still-valid")
    expect(creds?.accountId).toBe("acc-42")
  })

  test("missing access_token yields null regardless of id_token", () => {
    expect(getAccessCredentials({ tokens: { id_token: "x.y.z" } })).toBeNull()
    expect(getAccessCredentials({ tokens: {} })).toBeNull()
    expect(getAccessCredentials({})).toBeNull()
    expect(getAccessCredentials(null)).toBeNull()
  })

  test("empty access_token string yields null", () => {
    expect(getAccessCredentials({ tokens: { access_token: "" } })).toBeNull()
  })

  test("account_id optional", () => {
    const creds = getAccessCredentials({ tokens: { access_token: "at" } })
    expect(creds?.accessToken).toBe("at")
    expect(creds?.accountId).toBeUndefined()
  })
})

describe("readCodexAuth", () => {
  test("returns null for a missing file", async () => {
    expect(await readCodexAuth(join(tmpdir(), "does-not-exist-gpt-usage.json"))).toBeNull()
  })

  test("returns null for invalid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gpt-usage-"))
    try {
      const file = join(dir, "auth.json")
      await writeFile(file, "not json{")
      expect(await readCodexAuth(file)).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("parses a valid auth file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gpt-usage-"))
    try {
      const file = join(dir, "auth.json")
      await writeFile(
        file,
        JSON.stringify({ tokens: { access_token: "abc", account_id: "acc" } }),
      )
      const auth = await readCodexAuth(file)
      expect(auth?.tokens?.access_token).toBe("abc")
      expect(auth?.tokens?.account_id).toBe("acc")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
