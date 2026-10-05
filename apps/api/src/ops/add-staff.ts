import "dotenv/config";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { branches, tenants, users } from "../db/schema.js";
import { hashPassword } from "../domain/auth/auth.service.js";

// Creates a staff sign-in for an existing hospital (the product has no staff screen yet). An operator runs it once per person:
//
//   STAFF_PASSWORD='<a long password>' pnpm --filter @pulseos/api staff:add -- --hospital namokar --role FRONT_DESK \
//     --name "Name" --email name@clinic.example
//
// The hospital is named by its sign-in slug (never an id typed from a request), the password is read from the environment so it
// never lands in shell history or a process list, and nothing is printed that could be reused as a credential.

const ROLES = ["HOSPITAL_ADMIN", "FRONT_DESK", "PATIENT_COORDINATOR", "DOCTOR"] as const;
type StaffRole = (typeof ROLES)[number];

export interface AddStaffInput { loginSlug: string; role: StaffRole; name: string; email: string; password: string }
export type AddStaffResult = { ok: true; userId: string } | { ok: false; reason: "weak_password" | "role_not_allowed" | "invalid_input" | "unknown_hospital" | "branch_ambiguous" | "email_in_use" };

export async function addStaff(db: Db, input: AddStaffInput): Promise<AddStaffResult> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!ROLES.includes(input.role)) return { ok: false, reason: "role_not_allowed" }; // an owner (SUPER_ADMIN) comes from sign-up only
  if (input.password.length < 10) return { ok: false, reason: "weak_password" };
  if (name.length < 2 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, reason: "invalid_input" };

  const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.loginSlug, input.loginSlug)).limit(1);
  if (!tenant) return { ok: false, reason: "unknown_hospital" };
  // One branch is auto-used (the pilot shape); a hospital with several needs a deliberate choice this command does not offer.
  const hospitalBranches = await db.select({ id: branches.id }).from(branches).where(eq(branches.tenantId, tenant.id)).limit(2);
  if (hospitalBranches.length !== 1) return { ok: false, reason: "branch_ambiguous" };

  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`signup:${email}`}))`); // the same lock sign-up takes
    const [taken] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
    if (taken) return { ok: false as const, reason: "email_in_use" as const };
    const [u] = await tx.insert(users).values({ tenantId: tenant.id, branchId: hospitalBranches[0]!.id, name, email, passwordHash, role: input.role }).returning({ id: users.id });
    return { ok: true as const, userId: u!.id };
  });
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const { db, queryClient } = await import("../db/client.js");
  try {
    const r = await addStaff(db, { loginSlug: arg("hospital") ?? "", role: (arg("role") ?? "") as StaffRole, name: arg("name") ?? "", email: arg("email") ?? "", password: process.env.STAFF_PASSWORD ?? "" });
    if (!r.ok) {
      console.error(`Not created: ${r.reason}`);
      process.exitCode = 1;
      return;
    }
    // The id and the sign-in address only: no email, no password.
    console.log(`Created ${arg("role")} account ${r.userId} for /login/${arg("hospital")}`);
  } finally {
    await queryClient.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();
