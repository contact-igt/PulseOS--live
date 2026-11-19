import { eq, sql, type SQLWrapper } from "drizzle-orm";
import type { Db, DbOrTx, Tx } from "../../db/client.js";
import { tenants } from "../../db/schema.js";

export function hospitalIsActive(tenant: Pick<typeof tenants.$inferSelect, "lifecycleStatus" | "loginEnabled">) {
  return tenant.lifecycleStatus === "ACTIVE" && tenant.loginEnabled;
}

/** Correlated predicate for queue selection and atomic claims. */
export function activeHospital(tenantId: SQLWrapper) {
  return sql`exists (select 1 from ${tenants} where ${tenants.id} = ${tenantId} and ${tenants.lifecycleStatus} = 'ACTIVE' and ${tenants.loginEnabled})`;
}

export async function allowsHospitalWork(db: DbOrTx, tenantId: string) {
  const [tenant] = await db.select({
    lifecycleStatus: tenants.lifecycleStatus, loginEnabled: tenants.loginEnabled,
  })
    .from(tenants).where(eq(tenants.id, tenantId));
  return Boolean(tenant && hospitalIsActive(tenant));
}

export async function lockActiveHospital(tx: Tx, tenantId: string) {
  const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, tenantId)).for("share");
  return tenant && hospitalIsActive(tenant) ? tenant : null;
}

/** A suspension waits for a bounded provider submission already admitted under this lock. */
export async function submitWhileActive<T>(db: Db, tenantId: string, submit: (tx: Tx) => Promise<T>, scheduledFor?: Date) {
  let outcome: { value: T } | undefined;
  let rejected: { error: unknown } | undefined;
  try {
    return await db.transaction(async (tx) => {
      const tenant = await lockActiveHospital(tx, tenantId);
      if (!tenant ||
        (scheduledFor && tenant.lifecycleChangedAt && scheduledFor <= tenant.lifecycleChangedAt)) return null;
      try {
        outcome = { value: await submit(tx) };
        return outcome;
      } catch (error) {
        rejected = { error };
        throw error;
      }
    });
  } catch (error) {
    if (outcome) return outcome;
    throw rejected ? rejected.error : error;
  }
}
