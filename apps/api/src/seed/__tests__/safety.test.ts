import { describe, expect, it } from "vitest";
import { assertSafeToWipe } from "../safety.js";

const ok = (url: string, extra: Record<string, string> = {}) => () => assertSafeToWipe({ DATABASE_URL: url, ...extra } as NodeJS.ProcessEnv);

describe("assertSafeToWipe", () => {
  it.each([
    "postgres://localhost:5432/pulseos_dev",
    "postgres://user:pw@127.0.0.1:5432/pulseos_demo",
    "postgres://localhost/pulseos",
    "postgres://localhost/pulseos_test",
  ])("allows a local PulseOS database: %s", (url) => {
    expect(ok(url)).not.toThrow();
  });

  it("refuses production regardless of the database", () => {
    expect(ok("postgres://localhost/pulseos_dev", { NODE_ENV: "production" })).toThrow(/NODE_ENV=production/);
  });

  it("refuses a remote host", () => {
    expect(ok("postgres://db.example.com:5432/pulseos_dev")).toThrow(/not local/);
  });

  it.each(["postgres://localhost/postgres", "postgres://localhost/mydata", "postgres://localhost/pulseos_prod", "postgres://localhost/pulseos_live_copy", "postgres://localhost/other_pulseos"])(
    "refuses a database that is not a PulseOS demo database: %s",
    (url) => {
      expect(ok(url)).toThrow(/not a PulseOS demo database/);
    },
  );

  it("refuses a missing or malformed DATABASE_URL", () => {
    expect(() => assertSafeToWipe({} as NodeJS.ProcessEnv)).toThrow(/not set/);
    expect(ok("not a url")).toThrow(/not a valid URL/);
  });
});
