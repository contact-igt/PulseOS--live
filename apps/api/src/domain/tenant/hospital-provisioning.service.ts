import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Edition } from "@pulseos/types";
import type { Db, DbOrTx } from "../../db/client.js";
import { branches, tenantLoginConfigs, tenantProfiles, tenants, users } from "../../db/schema.js";
import { normalizePhone } from "../patient/phone.js";
import { hashPassword } from "../auth/auth.service.js";

/** Hospital and owner details validated by the caller before provisioning. */
export interface HospitalProvisioningInput {
  fullName: string;
  email: string;
  phone: string;
  organizationName: string;
  industry: string;
  organizationType?: string | undefined;
  department?: string | undefined;
  addressLine: string;
  locality?: string | undefined;
  city: string;
  state: string;
  pinCode: string;
  country: string;
  discoverySource: string;
  discoveryNotes?: string | undefined;
  edition: Edition;
}

/** Departments that already have an installable template; the others are recorded on the profile only. */
const TEMPLATE_BY_DEPARTMENT: Record<string, string> = { Ophthalmology: "ophthalmology", Gynaecology: "gynecology" };

export function hospitalTemplateKey(input: Pick<HospitalProvisioningInput, "industry" | "department">): string | null {
  return input.industry === "Healthcare" && input.department ? TEMPLATE_BY_DEPARTMENT[input.department] ?? null : null;
}

/** Words that must never be a hospital's sign-in address (they are, or could become, real routes). */
const RESERVED_SLUGS = new Set(["admin", "api", "app", "auth", "login", "logout", "signup", "sign-up", "dev", "developer", "demo", "test", "www", "settings", "static", "public", "pulseos", "support", "help", "billing", "root"]);

/** "ABC Eye Hospital" -> "abc-eye-hospital": lower-case words, at most 38 characters, starting with a letter. */
export function slugifyWorkspaceName(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/g, "");
  let slug = /^[a-z]/.test(base) ? base : `h-${base}`;
  if (slug.length < 3 || RESERVED_SLUGS.has(slug)) slug = `${slug || "hospital"}-workspace`;
  return slug.slice(0, 38).replace(/-+$/g, "");
}

/** The first free slug for this name: the plain one, then -2, -3 ... (inside the provisioning transaction, under a lock, so two requests cannot pick the same). */
async function uniqueSlug(tx: Pick<Db, "select" | "execute">, name: string): Promise<string> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('signup-slug'))`);
  const base = slugifyWorkspaceName(name);
  for (let n = 1; n <= 2_147_483_647; n++) {
    const candidate = n === 1 ? base : `${base.slice(0, 38 - String(n).length - 1)}-${n}`;
    const [taken] = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.loginSlug, candidate)).limit(1);
    if (!taken) return candidate;
  }
  throw new Error("Hospital login slug space exhausted");
}

export type HospitalProvisioningResult =
  | { ok: true; userId: string; tenantId: string; loginSlug: string }
  | { ok: false; reason: "email_in_use" | "invalid_phone" };

/** Creates a locked workspace and owner together. Redemption replaces the unusable initial credential. */
export async function provisionHospital(db: DbOrTx, input: HospitalProvisioningInput): Promise<HospitalProvisioningResult> {
  const email = input.email.trim().toLowerCase();
  const phone = normalizePhone(input.phone, "IN");
  const ownerPhone = phone.e164;
  if (!ownerPhone) return { ok: false, reason: "invalid_phone" };
  const passwordHash = await hashPassword(randomBytes(32).toString("base64url"));

  const created = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`signup:${email}`}))`);
    const [taken] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
    if (taken) return null;

    const loginSlug = await uniqueSlug(tx, input.organizationName);
    const [tenant] = await tx.insert(tenants).values({ name: input.organizationName, timezone: "Asia/Kolkata", edition: input.edition, loginEnabled: false, lifecycleStatus: "PROVISIONING", loginSlug }).returning();
    // Store branding now so the dedicated sign-in page is ready when the hospital activates.
    await tx.insert(tenantLoginConfigs).values({ tenantId: tenant!.id });
    const [branch] = await tx.insert(branches).values({ tenantId: tenant!.id, name: `${input.organizationName} – Main`, city: input.city }).returning();
    const [user] = await tx
      .insert(users)
      .values({ tenantId: tenant!.id, branchId: branch!.id, name: input.fullName, email, passwordHash, role: "SUPER_ADMIN" })
      .returning();
    await tx.insert(tenantProfiles).values({
      tenantId: tenant!.id,
      source: "platform",
      ownerName: input.fullName,
      ownerEmail: email,
      ownerPhone,
      industry: input.industry,
      organizationType: input.organizationType ?? null,
      department: input.department ?? null,
      addressLine: input.addressLine,
      locality: input.locality ?? null,
      city: input.city,
      state: input.state,
      pinCode: input.pinCode,
      country: input.country,
      discoverySource: input.discoverySource,
      discoveryNotes: input.discoveryNotes ?? null,
    });
    return { tenantId: tenant!.id, userId: user!.id, loginSlug };
  });
  if (!created) return { ok: false, reason: "email_in_use" };

  return { ok: true, ...created };
}
