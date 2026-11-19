import { sql } from "drizzle-orm";
import type { Tx } from "../../db/client.js";
import { users } from "../../db/schema.js";

export const hospitalTeamFields = {
  id: users.id, name: users.name, email: users.email, role: users.role, branchId: users.branchId,
};

export async function insertStaffAccount(tx: Tx, input: Pick<typeof users.$inferInsert,
  "tenantId" | "branchId" | "name" | "email" | "role" | "passwordHash">) {
  // Match the email lock used by hospital provisioning.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`signup:${input.email}`}))`);
  const [taken] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${input.email}`).limit(1);
  if (taken) return null;
  const [member] = await tx.insert(users).values(input).returning(hospitalTeamFields);
  return member!;
}
