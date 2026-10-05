import { defineConfig } from "vitest/config";

// Pin the process clock zone to UTC. Hospital "today" / day buckets must come from the
// tenant timezone (Asia/Kolkata), never from the server clock — on an IST dev machine a
// server-local-midnight bug would otherwise hide, because the two zones agree.
process.env.TZ = "UTC";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
    testTimeout: 20000,
    // Integration tests share one real Postgres instance; running test files
    // concurrently would race on shared demo-data state (e.g. exact seeded totals).
    fileParallelism: false,
  },
});
