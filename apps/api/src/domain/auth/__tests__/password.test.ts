import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../auth.service.js";

describe("password hashing (Argon2id)", () => {
  it("hashes and verifies a correct password", async () => {
    const hash = await hashPassword("a-local-demo-password");
    expect(hash).not.toBe("a-local-demo-password");
    expect(await verifyPassword(hash, "a-local-demo-password")).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("correct-password");
    expect(await verifyPassword(hash, "wrong-password")).toBe(false);
  });
});
