import { assertSafeToWipe } from "../seed/safety.js";

// Which database each kind of automated run may touch. Three never overlap:
//   development / manual QA   DATABASE_URL                 (e.g. pulseos_platform)
//   API integration tests     TEST_DATABASE_URL, else <dev db>_test
//   Playwright (isolated)     E2E_DATABASE_URL,  else <dev db>_e2e
// A test run can therefore never mutate the database a person is using in the browser, and every target must be a
// local PulseOS database (the same rule as the demo seed: never a remote, staging or production database).

export type TestTarget = "test" | "e2e";

function withDatabaseName(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

/** The database a test run of `target` uses. Throws (never falls back to the dev database) if it would be unsafe. */
export function resolveTestDatabaseUrl(target: TestTarget, env: NodeJS.ProcessEnv): string {
  const dev = env.DATABASE_URL;
  const explicit = target === "test" ? env.TEST_DATABASE_URL : env.E2E_DATABASE_URL;
  if (!explicit && !dev) throw new Error(`Set DATABASE_URL (or ${target === "test" ? "TEST_DATABASE_URL" : "E2E_DATABASE_URL"}) to run ${target} against a local database`);
  const url = explicit ?? withDatabaseName(dev!, `${databaseName(dev!)}_${target}`);
  if (dev && databaseName(url) === databaseName(dev) && !explicit) throw new Error("refusing to run tests against the development database");
  if (dev && explicit && databaseName(explicit) === databaseName(dev) && new URL(explicit).host === new URL(dev).host) {
    throw new Error(`${target === "test" ? "TEST_DATABASE_URL" : "E2E_DATABASE_URL"} must not be the development database (${databaseName(dev)})`);
  }
  assertSafeToWipe({ ...env, NODE_ENV: "test", DATABASE_URL: url });
  return url;
}
