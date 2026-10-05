import "dotenv/config";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, queryClient } from "./client.js";

await migrate(db, { migrationsFolder: "./src/db/migrations" });
await queryClient.end();
console.log("migrations applied");
