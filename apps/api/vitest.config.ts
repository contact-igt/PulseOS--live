import "dotenv/config";
import { defineConfig } from "vitest/config";
import { resolveTestDatabaseUrl } from "./src/lib/test-database.js";

// Pin the process clock zone to UTC. Hospital "today" / day buckets must come from the
// tenant timezone (Asia/Kolkata), never from the server clock — on an IST dev machine a
// server-local-midnight bug would otherwise hide, because the two zones agree.
process.env.TZ = "UTC";

// Integration tests run against their OWN database (TEST_DATABASE_URL, else <dev db>_test), never the development
// database a person may be using in the browser. Prepare it with `pnpm test:db:prepare`. See src/lib/test-database.ts.
process.env.DATABASE_URL = resolveTestDatabaseUrl("test", process.env);

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
    testTimeout: 20000,
    env: { DATABASE_URL: process.env.DATABASE_URL, TZ: "UTC" },
    // Integration tests share one real Postgres instance; running test files
    // concurrently would race on shared demo-data state (e.g. exact seeded totals).
    fileParallelism: false,
  },
});
