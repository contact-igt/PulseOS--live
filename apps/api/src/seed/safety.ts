// The demo seed deletes EVERY tenant before re-creating the two demo ones, so
// it must only ever run against a local, clearly-PulseOS database — never a
// production one, a remote one, or an unrelated local database that happens
// to be the default connection.
//
// No interactive prompt and no override flag: the check is a pure function of
// the environment so it works unattended (CI, `pnpm db:seed`) and is unit
// tested. A database that fails it simply isn't seedable from this script.

const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "::1", "[::1]"]);
// pulseos, pulseos_dev, pulseos_demo, pulseos_test ... but not "pulseos_prod".
const DEMO_DB_NAME = /^pulseos(_[a-z0-9]+)*$/;
const PRODUCTION_WORDS = /prod|live|staging/;

export function assertSafeToWipe(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV === "production") {
    throw new Error("Refusing to seed: NODE_ENV=production (the demo seed deletes all tenants)");
  }
  const raw = env.DATABASE_URL;
  if (!raw) throw new Error("Refusing to seed: DATABASE_URL is not set");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Refusing to seed: DATABASE_URL is not a valid URL");
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`Refusing to seed: database host "${url.hostname}" is not local (the demo seed deletes all tenants)`);
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!DEMO_DB_NAME.test(database) || PRODUCTION_WORDS.test(database)) {
    throw new Error(`Refusing to seed: database "${database}" is not a PulseOS demo database (expected pulseos, pulseos_dev, pulseos_demo, ...)`);
  }
}
