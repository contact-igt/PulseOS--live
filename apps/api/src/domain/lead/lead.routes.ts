import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePermission } from "../auth/permission.middleware.js";
import { parseOwnerFilter } from "../journey/journey.service.js";
import { createLead, getLeadsSummary, getLeadsWorkspace, LeadRangeError, listLeads, lookupPatientByPhone } from "./lead.service.js";
import { LEAD_VIEWS, type LeadStatus } from "@pulseos/types";

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);
const opt = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(emptyToUndefined, schema.optional());
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Unknown keys (a smuggled tenantId...) are stripped: the tenant always comes from the session.
const workspaceQuery = z.object({
  view: opt(z.enum(LEAD_VIEWS.map((v) => v.key) as [string, ...string[]])),
  range: opt(z.enum(["today", "yesterday", "7d", "9d", "14d", "30d", "90d", "this_month", "prev_month", "last_month", "custom"])),
  from: opt(ymd),
  to: opt(ymd),
  owner: opt(z.string().max(60)),
  source: opt(z.string().max(60)),
  service: opt(z.string().max(120)),
  status: opt(z.enum(["new", "uncontacted", "follow_up_due", "appointment_booked", "no_response", "converted", "lost"])),
  due: opt(z.literal("overdue")),
  fieldKey: opt(z.string().regex(/^[a-z][a-z0-9_]{1,47}$/)),
  fieldValue: opt(z.string().max(80)),
});

// A refused step keeps the HTTP meaning the same refusal has elsewhere (booking: 422 past / 409 taken).
const STEP_STATUS: Record<string, number> = {
  resource_unavailable: 409,
  appointment_time_in_past: 422,
  due_in_past: 422,
  doctor_not_found: 422,
  branch_not_found: 422,
  assignee_invalid: 422,
  follow_up_required: 422,
  outcome_not_found: 422,
  outcome_closes_journey: 422,
  outcome_disallows_appointment: 422,
  type_invalid: 422,
};

const createLeadBody = z.object({
  patientId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  dateOfBirth: z.string().optional(),
  age: z.number().int().optional(),
  phone: z.string().min(6),
  email: z.string().email().optional(),
  preferredLanguage: z.string().optional(),
  specialtyKey: z.string().min(1),
  branchId: z.string().uuid(),
  doctorId: z.string().uuid().optional(),
  sourceKey: z.string().min(1).max(60).optional(),
  source: z.enum(["meta", "google", "website", "whatsapp", "phone", "walk_in", "referral", "organic", "other"]).optional(),
  channel: z.enum(["MANUAL_CALL", "WHATSAPP", "INSTAGRAM_DM", "FACEBOOK_DM", "WALK_IN"]).optional(),
  campaignId: z.string().uuid().optional(),
  journeyType: z.string().min(1),
  ownerId: z.string().uuid().optional(),
  priority: z.enum(["normal", "high"]).optional(),
  notes: z.string().optional(),
  customFieldValues: z.record(z.string(), z.unknown()).optional(),
  outcomeKey: z.string().min(1).max(60).optional(),
  outcomeNote: z.string().max(2000).optional(),
  outcomeReason: z.string().max(500).optional(),
  nextStep: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.enum(["callback", "follow_up"]), dueAt: z.string().min(1).max(40), assignedTo: z.string().uuid().optional(), note: z.string().max(1000).optional() }),
      z.object({ kind: z.literal("appointment"), scheduledAt: z.string().min(1).max(40), doctorId: z.string().uuid(), branchId: z.string().uuid().optional(), note: z.string().max(500).optional() }),
      z.object({ kind: z.literal("none") }),
    ])
    .optional(),
  call: z.object({ direction: z.enum(["inbound", "outbound"]), connected: z.boolean(), durationSeconds: z.number().int().min(0).max(86_400).optional(), note: z.string().max(2000).optional() }).optional(),
  followUp: z
    .object({
      type: z.enum(["CALLBACK", "FOLLOW_UP", "APPOINTMENT_CONFIRMATION", "NO_SHOW_RECOVERY", "TREATMENT_DECISION", "POST_CARE", "RECALL", "OTHER"]),
      dueAt: z.string(),
      assignedTo: z.string().uuid().optional(),
    })
    .nullable()
    .optional(),
});

export async function leadRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requirePermission("MANAGE_LEADS"));

  app.get("/leads", async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const query = request.query as { status?: LeadStatus; specialtyKey?: string; source?: string; owner?: string };
    // owner = mine | unassigned | <userId>; "mine" is the SESSION user, never client-supplied.
    const owner = parseOwnerFilter(query.owner, request.sessionUser!.id);
    if (owner === "invalid") return reply.status(400).send({ error: "invalid_owner_filter" });
    return listLeads(app.db, tenantId, { status: query.status, specialtyKey: query.specialtyKey, source: query.source, owner }, request.sessionUser!.timezone);
  });

  // The Leads workspace: one request for the rows of a quick view, every view's count, the today strip and owner counts.
  app.get("/leads/workspace", async (request, reply) => {
    const parsed = workspaceQuery.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_query", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    const q = parsed.data;
    const owner = parseOwnerFilter(q.owner, request.sessionUser!.id);
    if (owner === "invalid") return reply.status(400).send({ error: "invalid_owner_filter" });
    try {
      return await getLeadsWorkspace(app.db, request.sessionUser!.tenantId, { ...q, owner } as Parameters<typeof getLeadsWorkspace>[2], request.sessionUser!.timezone, new Date(), request.sessionUser!.role);
    } catch (err) {
      if (err instanceof LeadRangeError) return reply.status(400).send({ error: "invalid_query", message: err.message });
      throw err;
    }
  });

  app.get("/leads/summary", async (request) => {
    const tenantId = request.sessionUser!.tenantId;
    return getLeadsSummary(app.db, tenantId, request.sessionUser!.timezone);
  });

  app.post("/leads/lookup", async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const { phone } = request.body as { phone?: string };
    if (!phone) return reply.status(400).send({ error: "invalid_request" });
    return lookupPatientByPhone(app.db, tenantId, phone);
  });

  app.post("/leads", async (request, reply) => {
    const tenantId = request.sessionUser!.tenantId;
    const actorId = request.sessionUser!.id;
    const parsed = createLeadBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request", details: parsed.error.flatten() });

    const result = await createLead(app.db, tenantId, actorId, parsed.data, request.sessionUser!.role, request.sessionUser!.timezone);
    if ("stepError" in result) {
      // The whole lead was refused and rolled back; the step and reason say which part and why.
      const { step, reason } = result.stepError;
      return reply.status(STEP_STATUS[reason] ?? 422).send({ error: reason, step });
    }
    if ("validationError" in result) {
      // Required fields missing wins; otherwise the values that do not fit their field type.
      if (result.missingRequiredFields.length > 0) return reply.status(422).send({ error: "missing_required_fields", fields: result.missingRequiredFields });
      return reply.status(422).send({ error: "invalid_field_values", fields: result.invalidFields });
    }
    return reply.status(201).send(result);
  });
}
