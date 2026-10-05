import type { FastifyInstance } from "fastify";
import { and, eq, or } from "drizzle-orm";
import { branches, marketingCampaigns, scheduleResources, tenants, users } from "../../db/schema.js";

export async function lookupRoutes(app: FastifyInstance) {
  app.get("/lookups", async (request) => {
    const tenantId = request.sessionUser!.tenantId;

    const [branchRows, doctorRows, ownerRows, campaignRows, [tenantRow]] = await Promise.all([
      app.db.select({ id: branches.id, name: branches.name }).from(branches).where(eq(branches.tenantId, tenantId)),
      // "Doctors" are the hospital's active scheduling profiles — a doctor does not need a login to appear here.
      app.db.select({ id: scheduleResources.id, name: scheduleResources.name }).from(scheduleResources).where(and(eq(scheduleResources.tenantId, tenantId), eq(scheduleResources.isActive, true))).orderBy(scheduleResources.name),
      app.db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(and(eq(users.tenantId, tenantId), or(eq(users.role, "FRONT_DESK"), eq(users.role, "PATIENT_COORDINATOR")))),
      app.db.select({ id: marketingCampaigns.id, name: marketingCampaigns.name, source: marketingCampaigns.source }).from(marketingCampaigns).where(eq(marketingCampaigns.tenantId, tenantId)),
      app.db.select({ clinicHours: tenants.clinicHours }).from(tenants).where(eq(tenants.id, tenantId)).limit(1),
    ]);

    return { clinicHours: tenantRow?.clinicHours ?? null, branches: branchRows, doctors: doctorRows, owners: ownerRows, campaigns: campaignRows };
  });
}
