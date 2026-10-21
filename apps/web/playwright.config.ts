import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * E2E_ISOLATED=1: Playwright starts its OWN API and web servers on the e2e database (E2E_DATABASE_URL, else
 * <dev db>_e2e - prepare it with `pnpm --filter @pulseos/api test:db:prepare e2e`). It refuses to start if anything already
 * listens on the ports, so an isolated run can never fall back to the development servers and their database.
 * Without it, specs run against whatever is serving localhost:3310 / 4310 (the classic local workflow).
 */
const isolated = process.env.E2E_ISOLATED === "1";

function apiEnvFile(): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(resolve(__dirname, "../api/.env"), "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
  } catch {
    return {};
  }
}

function isolatedDatabase(apiEnv: Record<string, string>): string {
  const dev = process.env.DATABASE_URL ?? apiEnv.DATABASE_URL;
  const explicit = process.env.E2E_DATABASE_URL;
  if (!explicit && !dev) throw new Error("E2E_ISOLATED needs DATABASE_URL (apps/api/.env) or E2E_DATABASE_URL");
  const url = new URL(explicit ?? dev!);
  if (!explicit) url.pathname = `${url.pathname}_e2e`;
  const name = url.pathname.slice(1);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) throw new Error(`E2E database must be local, not ${url.hostname}`);
  if (!/^pulseos(_[a-z0-9]+)*$/.test(name) || /prod|live|staging/.test(name)) throw new Error(`E2E database must be a PulseOS test database, not ${name}`);
  if (dev && new URL(dev).pathname.slice(1) === name) throw new Error("E2E database must not be the development database");
  return url.toString();
}

const apiEnv = isolated ? apiEnvFile() : {};
const e2eDatabase = isolated ? isolatedDatabase(apiEnv) : undefined;
if (isolated) {
  // Specs' own SQL helpers (e2e/support/fixtures.ts) and passwords follow the isolated database.
  process.env.E2E_DATABASE_URL = e2eDatabase;
  process.env.DEMO_PASSWORD ??= apiEnv.DEMO_PASSWORD;
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  // Screenshot-heavy loops capture many full pages per test: a generous per-test budget instead of ad hoc reruns.
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3310",
    trace: "retain-on-failure",
    screenshot: "on",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  ...(isolated
    ? {
        webServer: [
          {
            command: "npx tsx src/server.ts",
            cwd: resolve(__dirname, "../api"),
            url: "http://localhost:4310/health",
            reuseExistingServer: false,
            timeout: 120_000,
            env: { ...apiEnv, DATABASE_URL: e2eDatabase!, PORT: "4310", WEB_ORIGIN: "http://localhost:3310", ENABLE_DEV_LOGIN: "true", NODE_ENV: "development" },
          },
          {
            command: "npx next dev --port 3310",
            cwd: __dirname,
            url: "http://localhost:3310/login",
            reuseExistingServer: false,
            timeout: 240_000,
          },
        ],
      }
    : {}),
});
