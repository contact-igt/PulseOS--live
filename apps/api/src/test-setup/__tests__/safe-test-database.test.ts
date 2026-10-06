import { describe, expect, it } from "vitest";
import { assertSafeTestDatabase, describeDatabaseTarget } from "../safe-test-database.js";

describe("test database guard", () => {
  it("allows loopback databases", () => {
    expect(assertSafeTestDatabase("postgres://u:p@127.0.0.1:54329/pulseos_ccs_test")).toEqual({ host: "127.0.0.1", name: "pulseos_ccs_test" });
    expect(assertSafeTestDatabase("postgres://u:p@localhost/x").host).toBe("localhost");
    expect(assertSafeTestDatabase("postgres://u:p@[::1]:5432/x").name).toBe("x");
  });

  it("refuses a Railway (or any remote) database, and its message never carries credentials", () => {
    const url = "postgres://postgres:synthetic-password@example-host.proxy.rlwy.net:12345/railway";
    expect(() => assertSafeTestDatabase(url)).toThrow(/non-local database host "example-host.proxy.rlwy.net"/);
    try {
      assertSafeTestDatabase(url);
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("synthetic-password");
    }
  });

  it("refuses look-alike hosts and a missing or malformed URL", () => {
    expect(() => assertSafeTestDatabase("postgres://u:p@localhost.evil.example/x")).toThrow();
    expect(() => assertSafeTestDatabase("postgres://u:p@127.0.0.1.nip.io/x")).toThrow();
    expect(() => assertSafeTestDatabase(undefined)).toThrow(/not set/);
    expect(() => assertSafeTestDatabase("not a url")).toThrow(/not a valid URL/);
  });

  it("a remote disposable DB needs the explicit opt-in", () => {
    expect(assertSafeTestDatabase("postgres://u:p@db.example.test/x", true).host).toBe("db.example.test");
  });

  it("describes a target without credentials", () => {
    expect(describeDatabaseTarget("postgres://u:secret@h:1/n")).toEqual({ host: "h", name: "n" });
  });
});
