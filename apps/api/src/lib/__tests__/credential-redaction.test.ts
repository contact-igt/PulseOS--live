import { describe, expect, it } from "vitest";
import { isCredentialName, redactUrlSecrets, withoutCredentials } from "../credential-redaction.js";

describe("credential redaction", () => {
  it("recognises credential names regardless of case and separators", () => {
    for (const n of ["api_key", "apiKey", "API-KEY", "x_api_key".replace("x_", ""), "secret_key", "integrationKey", "Token", "access_token", "password"]) expect(isCredentialName(n), n).toBe(true);
    for (const n of ["call_id", "caller_number", "keyboard", "status"]) expect(isCredentialName(n), n).toBe(false);
  });

  it("strips credential fields from a payload and keeps the rest", () => {
    expect(withoutCredentials({ call_id: "1", api_key: "synthetic-k", secretKey: "synthetic-s", caller_number: "98" })).toEqual({ call_id: "1", caller_number: "98" });
    expect(withoutCredentials({ api_key: "synthetic-k" })).toEqual({});
  });

  it("redacts credential query values in a loggable URL and leaves other parameters alone", () => {
    const out = redactUrlSecrets("/webhooks/ccs/abc?api_key=synthetic-key-1&call_id=42&secretKey=synthetic-2");
    expect(out).not.toContain("synthetic-key-1");
    expect(out).not.toContain("synthetic-2");
    expect(out).toContain("call_id=42");
    expect(out).toContain("api_key=[redacted]");
    expect(redactUrlSecrets("/health")).toBe("/health");
    expect(redactUrlSecrets("/x?a=1")).toBe("/x?a=1");
  });
});
