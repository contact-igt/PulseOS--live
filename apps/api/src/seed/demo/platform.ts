import { eq, sql } from "drizzle-orm";
import type { PlatformRole } from "@pulseos/types";
import { db } from "../../db/client.js";
import { platformUsers } from "../../db/schema.js";

/**
 * Fictional Invictus platform staff for LOCAL development only (the seed refuses any non-local or production database).
 * One account per platform role, all with the local DEMO_PASSWORD. Upserted by email, so re-seeding never duplicates them.
 */
export const DEMO_PLATFORM_STAFF: { email: string; name: string; role: PlatformRole }[] = [
  { email: "owner@platform.pulseos.local", name: "Aarav Mehta", role: "PLATFORM_OWNER" },
  { email: "admin@platform.pulseos.local", name: "Diya Raman", role: "PLATFORM_ADMIN" },
  { email: "implementation@platform.pulseos.local", name: "Kabir Nair", role: "IMPLEMENTATION_ADMIN" },
  { email: "support@platform.pulseos.local", name: "Meera Iyer", role: "SUPPORT_AGENT" },
  { email: "auditor@platform.pulseos.local", name: "Rohan Das", role: "PLATFORM_AUDITOR" },
];

export async function seedPlatformStaff(passwordHash: string): Promise<void> {
  for (const s of DEMO_PLATFORM_STAFF) {
    const [existing] = await db.select({ id: platformUsers.id }).from(platformUsers).where(sql`lower(${platformUsers.email}) = ${s.email}`).limit(1);
    if (existing) await db.update(platformUsers).set({ name: s.name, role: s.role, passwordHash, status: "ACTIVE", updatedAt: new Date() }).where(eq(platformUsers.id, existing.id));
    else await db.insert(platformUsers).values({ ...s, passwordHash, status: "ACTIVE" });
  }
}
