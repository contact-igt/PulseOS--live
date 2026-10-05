import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireCapability, requirePermission } from "../auth/permission.middleware.js";
import { getCampaignPerformance, getCampaignSpendAtRisk, getMarketingEfficiency } from "./campaign.service.js";
import { isRealDate } from "../../lib/hospital-time.js";
import type { CampaignFilters } from "@pulseos/types";

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);
const opt = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(emptyToUndefined, schema.optional());
const day = z.string().refine(isRealDate, "Use a real date as YYYY-MM-DD");

// Unknown keys (e.g. a smuggled tenantId) are stripped — tenant always comes from the session. Dates are hospital-local days.
const querySchema = z
  .object({
    branchId: opt(z.string().uuid()),
    specialtyKey: opt(z.string().min(1).max(120)),
    source: opt(z.enum(["meta", "google", "website", "whatsapp", "phone", "walk_in", "referral", "organic", "other"])),
    campaignId: opt(z.string().uuid()),
    dateFrom: opt(day),
    dateTo: opt(day),
  })
  .refine((q) => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo, { message: "dateFrom must not be after dateTo", path: ["dateFrom"] });

function parse(request: FastifyRequest, reply: FastifyReply): CampaignFilters | null {
  const result = querySchema.safeParse(request.query);
  if (!result.success) {
    reply.status(400).send({ error: "invalid_query", issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    return null;
  }
  return result.data as CampaignFilters;
}

export async function campaignRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireCapability("CAMPAIGNS"));
  app.addHook("preHandler", requirePermission("VIEW_MARKETING"));

  app.get("/campaigns/performance", async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const query = parse(request, reply);
    if (!query) return reply;
    return getCampaignPerformance(app.db, tenantId, query);
  });

  app.get("/campaigns/marketing-efficiency", async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const query = parse(request, reply);
    if (!query) return reply;
    return getMarketingEfficiency(app.db, tenantId, query);
  });

  app.get("/campaigns/spend-at-risk", async (request) => {
    const tenantId = request.sessionUser!.tenantId;
    return getCampaignSpendAtRisk(app.db, tenantId);
  });
}
