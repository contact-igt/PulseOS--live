import "dotenv/config";
import { spawnSync } from "node:child_process";
import postgres from "postgres";
import { databaseName, resolveTestDatabaseUrl, type TestTarget } from "../lib/test-database.js";

// Reset a test database to "all migrations + a fresh demo seed":  pnpm test:db:prepare [test|e2e]
// Refuses anything that is not a local PulseOS database, and never touches the development database.

const target = (process.argv[2] ?? "test") as TestTarget;
if (target !== "test" && target !== "e2e") throw new Error("usage: prepare-test-db [test|e2e]");
const url = resolveTestDatabaseUrl(target, process.env);
const name = databaseName(url);

const admin = postgres(Object.assign(new URL(url), { pathname: "/postgres" }).toString(), { max: 1, onnotice: () => {} });
const exists = await admin`select 1 from pg_database where datname = ${name}`;
if (exists.length === 0) await admin.unsafe(`create database "${name.replace(/"/g, "")}"`);
await admin.end();

const sql = postgres(url, { max: 1, onnotice: () => {} });
await sql.unsafe("drop schema if exists drizzle cascade; drop schema if exists public cascade; create schema public;");
await sql.end();

const env = { ...process.env, DATABASE_URL: url };
for (const [label, args] of [["migrate", ["src/db/migrate.ts"]], ["seed", ["src/seed/seed.ts"]]] as const) {
  const r = spawnSync("npx", ["tsx", ...args], { env, stdio: ["ignore", "ignore", "inherit"] });
  if (r.status !== 0) throw new Error(`${label} failed for ${name}`);
}
console.log(`${target} database ready: ${name} (migrated and freshly seeded)`);
