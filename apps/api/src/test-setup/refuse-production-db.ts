// Vitest setup file: runs before every test file. db/client.ts loads apps/api/.env itself (dotenv never overrides a
// variable that is already set), so load it the same way here and judge the URL the tests would actually use.
import "dotenv/config";
import { assertSafeTestDatabase } from "./safe-test-database.js";

assertSafeTestDatabase(process.env.DATABASE_URL, process.env.PULSEOS_TEST_ALLOW_REMOTE_DB === "1");
