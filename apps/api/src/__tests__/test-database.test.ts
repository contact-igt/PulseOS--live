import { describe, expect, it } from "vitest";
import { resolveTestDatabaseUrl } from "../lib/test-database.js";

describe("test database isolation", () => {
  const dev = "postgres://localhost:5432/pulseos_platform";

  it("derives a separate database per run kind from the development one", () => {
    expect(resolveTestDatabaseUrl("test", { DATABASE_URL: dev })).toMatch(/\/pulseos_platform_test$/);
    expect(resolveTestDatabaseUrl("e2e", { DATABASE_URL: dev })).toMatch(/\/pulseos_platform_e2e$/);
  });

  it("honours an explicit local test database", () => {
    expect(resolveTestDatabaseUrl("test", { DATABASE_URL: dev, TEST_DATABASE_URL: "postgres://localhost:5432/pulseos_ci" })).toMatch(/pulseos_ci$/);
  });

  it("never runs against the development database", () => {
    expect(() => resolveTestDatabaseUrl("test", { DATABASE_URL: dev, TEST_DATABASE_URL: dev })).toThrow(/development database/);
    expect(() => resolveTestDatabaseUrl("e2e", { DATABASE_URL: dev, E2E_DATABASE_URL: dev })).toThrow(/development database/);
  });

  it("never runs against a remote or production-looking database", () => {
    expect(() => resolveTestDatabaseUrl("test", { DATABASE_URL: dev, TEST_DATABASE_URL: "postgres://db.railway.internal:5432/pulseos_test" })).toThrow(/not local/);
    expect(() => resolveTestDatabaseUrl("test", { DATABASE_URL: dev, TEST_DATABASE_URL: "postgres://localhost:5432/pulseos_prod" })).toThrow();
    expect(() => resolveTestDatabaseUrl("test", { DATABASE_URL: "postgres://localhost:5432/customers" })).toThrow();
  });
});
