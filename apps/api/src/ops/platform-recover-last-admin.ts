import { z } from "zod";
import { db, queryClient } from "../db/client.js";
import { authorizeLastPlatformAdminRecovery } from "../domain/platform/platform-auth.service.js";
import { platformMfaKey } from "../domain/platform/platform-mfa.js";

try {
  const [authorization, rawId, caseId, extra] = process.argv.slice(2);
  const id = z.string().uuid().safeParse(rawId);
  if (!process.stdin.isTTY || !process.stdout.isTTY || authorization !== "--authorized-identity-verified" ||
    !id.success || !caseId || extra || !platformMfaKey()) {
    console.error("Use a private interactive terminal: platform:recover-last-admin --authorized-identity-verified <account UUID> <INC-reference>");
    process.exitCode = 1;
  } else {
    const result = await authorizeLastPlatformAdminRecovery(db, id.data, caseId);
    if (!result) {
      console.error("Recovery refused. Review account eligibility and the incident record.");
      process.exitCode = 1;
    } else {
      process.stdout.write(`One-time recovery credential: ${result.recoveryToken}\nExpires: ${result.expiresAt.toISOString()}\n`);
    }
  }
} catch {
  console.error("Platform recovery failed.");
  process.exitCode = 1;
} finally {
  await queryClient.end();
}
