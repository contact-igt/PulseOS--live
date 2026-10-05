import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { SIGNUP_DEPARTMENTS, SIGNUP_DISCOVERY_SOURCES, SIGNUP_EDITIONS, SIGNUP_INDUSTRIES, SIGNUP_ORGANIZATION_TYPES, type Edition } from "@pulseos/types";
import type { Db } from "../../db/client.js";
import { branches, tenantLoginConfigs, tenantProfiles, tenants, users } from "../../db/schema.js";
import { installDepartmentTemplate } from "../specialty/department.service.js";
import { normalizePhone } from "../patient/phone.js";
import { hashPassword } from "./auth.service.js";

const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional().transform((v) => (v ? v : undefined));

/**
 * The public sign-up payload. `.strict()`: a field the form does not send - above all a `tenantId` - is refused, never
 * silently ignored. Tenant identity is created by the server.
 */
export const signupSchema = z
  .object({
    fullName: text(2, 80),
    email: z.string().trim().toLowerCase().email().max(254),
    phone: text(6, 24),
    password: z.string().min(10).max(128),
    organizationName: text(2, 120),
    industry: z.enum(SIGNUP_INDUSTRIES),
    organizationType: z.enum(SIGNUP_ORGANIZATION_TYPES).optional(),
    department: z.enum(SIGNUP_DEPARTMENTS).optional(),
    addressLine: text(3, 160),
    locality: optionalText(80),
    city: text(2, 80),
    state: text(2, 80),
    pinCode: z.string().trim().regex(/^\d{6}$/, "PIN code must be 6 digits"),
    country: text(2, 60).default("India"),
    discoverySource: z.enum(SIGNUP_DISCOVERY_SOURCES),
    discoveryNotes: optionalText(300),
    edition: z.enum(SIGNUP_EDITIONS).default("V1"),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.industry === "Healthcare") {
      if (!v.organizationType) ctx.addIssue({ code: "custom", path: ["organizationType"], message: "Choose the organization type" });
      if (!v.department) ctx.addIssue({ code: "custom", path: ["department"], message: "Choose a department" });
    }
    if (v.password.toLowerCase() === v.email) ctx.addIssue({ code: "custom", path: ["password"], message: "The password must not be your email" });
  });

export type SignupPayload = z.infer<typeof signupSchema>;

const EDITION: Record<SignupPayload["edition"], Edition> = { V1: "BETA_V1_CORE", V2: "BETA_V2_GROWTH" };
/** Departments that already have an installable template; the others are recorded on the profile only. */
const TEMPLATE_BY_DEPARTMENT: Record<string, string> = { Ophthalmology: "ophthalmology", Gynaecology: "gynecology" };

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

/** The first free slug for this name: the plain one, then -2, -3 ... (inside the sign-up transaction, under a lock, so two sign-ups cannot pick the same). */
async function uniqueSlug(tx: Pick<Db, "select" | "execute">, name: string): Promise<string> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('signup-slug'))`);
  const base = slugifyWorkspaceName(name);
  for (let n = 1; n <= 50; n++) {
    const candidate = n === 1 ? base : `${base.slice(0, 38 - String(n).length - 1)}-${n}`;
    const [taken] = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.loginSlug, candidate)).limit(1);
    if (!taken) return candidate;
  }
  return `${base.slice(0, 29)}-${Date.now().toString(36)}`.slice(0, 38);
}

export type SignupResult =
  | { ok: true; userId: string; tenantId: string; template: "installed" | "none" | "failed"; loginSlug: string }
  | { ok: false; reason: "email_in_use" | "invalid_phone" };

/**
 * Creates the hospital. One transaction makes the tenant, its main branch, the first Super Admin (hashed password) and
 * the profile; an advisory lock on the email makes a double-submit (or two tabs) create exactly one hospital - the
 * second request waits, sees the account and is refused. The department template is installed right after (it is
 * idempotent); if that fails the workspace still exists and says so, rather than rolling the sign-up back.
 */
export async function signUpHospital(db: Db, input: SignupPayload, opts: { devVisible: boolean }): Promise<SignupResult> {
  const phone = normalizePhone(input.phone, "IN");
  const ownerPhone = phone.e164;
  if (!ownerPhone) return { ok: false, reason: "invalid_phone" };
  const passwordHash = await hashPassword(input.password);

  const created = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`signup:${input.email}`}))`);
    const [taken] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${input.email}`).limit(1);
    if (taken) return null;

    const loginSlug = await uniqueSlug(tx, input.organizationName);
    const [tenant] = await tx.insert(tenants).values({ name: input.organizationName, timezone: "Asia/Kolkata", edition: EDITION[input.edition], loginSlug }).returning();
    // The hospital's own sign-in page exists from this moment. The row holds only optional words; the defaults cover the rest.
    await tx.insert(tenantLoginConfigs).values({ tenantId: tenant!.id });
    const [branch] = await tx.insert(branches).values({ tenantId: tenant!.id, name: `${input.organizationName} – Main`, city: input.city }).returning();
    const [user] = await tx
      .insert(users)
      .values({ tenantId: tenant!.id, branchId: branch!.id, name: input.fullName, email: input.email, passwordHash, role: "SUPER_ADMIN" })
      .returning();
    await tx.insert(tenantProfiles).values({
      tenantId: tenant!.id,
      source: "signup",
      devVisible: opts.devVisible,
      ownerName: input.fullName,
      ownerEmail: input.email,
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

  const templateKey = input.industry === "Healthcare" && input.department ? TEMPLATE_BY_DEPARTMENT[input.department] : undefined;
  let template: "installed" | "none" | "failed" = "none";
  if (templateKey) {
    try {
      const r = await installDepartmentTemplate(db, created.tenantId, templateKey);
      template = r.ok ? "installed" : "failed";
    } catch {
      template = "failed";
    }
  }
  return { ok: true, ...created, template };
}

/** Exposed for the route: the tenant row after sign-up (name only - never the profile). */
export async function tenantName(db: Db, tenantId: string): Promise<string> {
  const [t] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return t?.name ?? "";
}
