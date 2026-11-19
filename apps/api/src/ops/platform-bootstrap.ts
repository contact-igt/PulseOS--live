import { z } from "zod";
import { db, queryClient } from "../db/client.js";
import { bootstrapPlatform } from "../domain/platform/platform-auth.service.js";
import { platformMfaKey } from "../domain/platform/platform-mfa.js";

try {
  const [confirmation, rawEmail, action, extra] = process.argv.slice(2);
  const email = z.string().trim().toLowerCase().email().max(254).safeParse(rawEmail);
  if (confirmation !== "--authorized" || !email.success || !platformMfaKey() || extra || (action && action !== "--renew-pending")) {
    console.error("Usage: platform:bootstrap --authorized <email> [--renew-pending]. Configure PLATFORM_MFA_KEY in the operator environment first.");
    process.exitCode = 1;
  } else {
    const result = await bootstrapPlatform(db, email.data, action === "--renew-pending");
    if (result.state === "refused") process.exitCode = 1;
    console.log(JSON.stringify(result));
  }
} catch {
  console.error("Platform bootstrap failed.");
  process.exitCode = 1;
} finally {
  await queryClient.end();
}
