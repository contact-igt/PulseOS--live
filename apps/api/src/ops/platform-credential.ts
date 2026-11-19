import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, queryClient } from "../db/client.js";
import { platformIdentities } from "../db/schema.js";
import { digest, HOSPITAL_ONBOARDING_ROLE as role } from "../domain/tenant/hospital-onboarding.service.js";

const [action, rawLabel] = process.argv.slice(2);
const label = rawLabel?.trim();

try {
  if (!label || label.length > 100 || !["issue", "revoke"].includes(action ?? "")) {
    throw new Error("Usage: platform-credential <issue|revoke> <operator-label>");
  }
  if (action === "revoke") {
    const [revoked] = await db.update(platformIdentities).set({ revokedAt: new Date() })
      .where(eq(platformIdentities.label, label)).returning({ id: platformIdentities.id });
    if (!revoked) throw new Error("Platform identity not found");
    console.log("Platform credential revoked.");
  } else {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const credentialHash = digest(token);
    const [identity] = await db.insert(platformIdentities).values({ label, role, credentialHash, expiresAt })
      .onConflictDoUpdate({
        target: platformIdentities.label,
        set: { credentialHash, expiresAt, revokedAt: null },
        setWhere: eq(platformIdentities.role, role),
      }).returning({ id: platformIdentities.id });
    if (!identity) throw new Error("Platform identity belongs to another role");
    console.log(JSON.stringify({ operatorId: identity.id, expiresAt, token }));
  }
} finally {
  await queryClient.end();
}
