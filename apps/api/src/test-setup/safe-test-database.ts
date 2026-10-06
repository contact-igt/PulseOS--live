// Tests create and delete tenants, so they must never run against a shared or production database. The rule is an
// allowlist: loopback hosts only. A remote throwaway test DB needs an explicit, deliberate PULSEOS_TEST_ALLOW_REMOTE_DB=1.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export interface DatabaseTarget {
  host: string;
  name: string;
}

export function describeDatabaseTarget(url: string): DatabaseTarget {
  const u = new URL(url);
  return { host: u.hostname, name: u.pathname.replace(/^\//, "") };
}

/** Throws unless the URL points at a local database (or remote tests were explicitly allowed). Never prints credentials. */
export function assertSafeTestDatabase(url: string | undefined, allowRemote = false): DatabaseTarget {
  if (!url) throw new Error("Refusing to run tests: DATABASE_URL is not set.");
  let target: DatabaseTarget;
  try {
    target = describeDatabaseTarget(url);
  } catch {
    throw new Error("Refusing to run tests: DATABASE_URL is not a valid URL.");
  }
  if (LOCAL_HOSTS.has(target.host.toLowerCase())) return target;
  if (allowRemote) return target;
  throw new Error(
    `Refusing to run tests against non-local database host "${target.host}" (db "${target.name}"). ` +
      "Tests create and delete tenants. Point DATABASE_URL at a local/disposable Postgres, e.g. " +
      "DATABASE_URL=postgres://user:pass@127.0.0.1:5432/pulseos_test (or set PULSEOS_TEST_ALLOW_REMOTE_DB=1 for a deliberately disposable remote DB).",
  );
}
