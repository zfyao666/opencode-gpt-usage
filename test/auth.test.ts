import { describe, expect, test } from "bun:test"
import { getAccessCredentials } from "../src/auth"

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
    expect(creds?.accessToken).toBe("at-still-valid")
    expect(creds?.accountId).toBe("acc-42")
  })

  test("missing or empty access_token yields null regardless of id_token", () => {
    expect(getAccessCredentials({ tokens: { id_token: "x.y.z" } })).toBeNull()
    expect(getAccessCredentials({ tokens: { access_token: "" } })).toBeNull()
    expect(getAccessCredentials({ tokens: {} })).toBeNull()
    expect(getAccessCredentials({})).toBeNull()
    expect(getAccessCredentials(null)).toBeNull()
  })
})
