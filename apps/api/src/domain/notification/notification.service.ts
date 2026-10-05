import { and, asc, desc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { appointments, branches, connectorEvents, messageTemplates, notificationRules, notifications, outboundWebhooks, patients, scheduleResources, tenants, timelineEvents, treatmentOpportunities, users } from "../../db/schema.js";
import { TEMPLATE_VARIABLES, type MessageTemplateVm, type NotificationOffsetUnit, type NotificationRuleVm, type NotificationSubject, type NotificationVm, type TemplatePurpose, type WhatsAppPreview } from "@pulseos/types";
import { tenantCapabilityMap } from "../capability/capability.service.js";
import { getConnectorByTenantAndProvider, getConnectorSecrets, touchConnectorError, touchConnectorSuccess } from "../connector/connector.service.js";
import { getMessagingAdapter } from "../connector/registry.js";
import { AmbiguousSendError, type MessagingProviderAdapter } from "../connector/types.js";
import { redactLogText } from "../security/redact.js";
import { DEFAULT_RULES, notificationKey, planNotifications, type PlanRule } from "./notification-plan.js";
import { DEFAULT_TEMPLATES, renderTemplate, templateParameters, validateTemplateBody } from "./message-template.js";
import { buildFullWebhookUrl, resolveDynamicPayload, validateWebhookUrl } from "../integration/webhook-rules.js";
import { emitIntegrationEvent } from "../integration/domain-events.js";

type Result<T> = ({ ok: true } & T) | { ok: false; reason: string };

const allowInsecure = () => process.env.WEBHOOK_ALLOW_INSECURE === "true" && process.env.NODE_ENV !== "production";

export const MAX_SEND_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [2 * 60_000, 10 * 60_000];
const STALE_PROCESSING_MS = 5 * 60_000;
/** How long after its moment a planned reminder may still go out (the worker ticks every 30 s). */
const LATE_GRACE_MS = 15 * 60_000;
const WA_PROVIDER = "whatsapp_meta_cloud";

// ---------------------------------------------------------------------------
// Defaults, templates, rules
// ---------------------------------------------------------------------------

const purposeForRule = (subject: string, kind: string): TemplatePurpose => (subject === "SURGERY" ? "SURGERY_REMINDER" : kind === "CONFIRMATION" ? "APPOINTMENT_CONFIRMATION" : "APPOINTMENT_REMINDER");

/** First use of a tenant: its default templates and rules. Idempotent, never overwrites an edit. */
export async function ensureNotificationDefaults(db: Db, tenantId: string): Promise<void> {
  const [anyRule] = await db.select({ id: notificationRules.id }).from(notificationRules).where(eq(notificationRules.tenantId, tenantId)).limit(1);
  for (const t of DEFAULT_TEMPLATES) {
    await db.insert(messageTemplates).values({ tenantId, ...t }).onConflictDoNothing();
  }
  if (anyRule) return;
  const templates = await db.select().from(messageTemplates).where(eq(messageTemplates.tenantId, tenantId));
  const byPurpose = new Map(templates.map((t) => [t.purpose, t.id]));
  for (const r of DEFAULT_RULES) {
    await db.insert(notificationRules).values({ tenantId, subject: r.subject, kind: r.kind, offsetValue: r.offsetValue, offsetUnit: r.offsetUnit, templateId: byPurpose.get(purposeForRule(r.subject, r.kind)) ?? null });
  }
}

const templateVm = (t: typeof messageTemplates.$inferSelect): MessageTemplateVm => ({
  id: t.id,
  purpose: t.purpose as TemplatePurpose,
  name: t.name,
  providerTemplateName: t.providerTemplateName,
  language: t.language,
  body: t.body,
  variables: TEMPLATE_VARIABLES[t.purpose as TemplatePurpose] ?? [],
  enabled: t.enabled,
});

const ruleVm = (r: typeof notificationRules.$inferSelect): NotificationRuleVm => ({
  id: r.id,
  subject: r.subject as NotificationSubject,
  kind: r.kind as NotificationRuleVm["kind"],
  enabled: r.enabled,
  offsetValue: r.offsetValue,
  offsetUnit: r.offsetUnit as NotificationOffsetUnit,
  channel: "WHATSAPP",
  templateId: r.templateId,
  minGapMinutes: r.minGapMinutes,
});

export async function listTemplates(db: Db, tenantId: string): Promise<MessageTemplateVm[]> {
  await ensureNotificationDefaults(db, tenantId);
  const rows = await db.select().from(messageTemplates).where(eq(messageTemplates.tenantId, tenantId)).orderBy(asc(messageTemplates.purpose));
  return rows.map(templateVm);
}

export interface UpdateTemplateInput {
  name?: string;
  providerTemplateName?: string;
  language?: string;
  body?: string;
  enabled?: boolean;
}

export async function updateTemplate(db: Db, tenantId: string, id: string, input: UpdateTemplateInput): Promise<Result<{ template: MessageTemplateVm }>> {
  const [existing] = await db.select().from(messageTemplates).where(and(eq(messageTemplates.tenantId, tenantId), eq(messageTemplates.id, id))).limit(1);
  if (!existing) return { ok: false, reason: "template_not_found" };
  if (input.body !== undefined) {
    if (!input.body.trim() || input.body.length > 1024) return { ok: false, reason: "invalid_body" };
    const check = validateTemplateBody(existing.purpose as TemplatePurpose, input.body);
    if (!check.ok) return { ok: false, reason: "unknown_variable" };
  }
  const [row] = await db
    .update(messageTemplates)
    .set({
      name: input.name?.trim() || existing.name,
      providerTemplateName: input.providerTemplateName?.trim() || existing.providerTemplateName,
      language: input.language?.trim() || existing.language,
      body: input.body ?? existing.body,
      enabled: input.enabled ?? existing.enabled,
      updatedAt: new Date(),
    })
    .where(eq(messageTemplates.id, id))
    .returning();
  return { ok: true, template: templateVm(row!) };
}

export async function listRules(db: Db, tenantId: string): Promise<NotificationRuleVm[]> {
  await ensureNotificationDefaults(db, tenantId);
  const rows = await db.select().from(notificationRules).where(eq(notificationRules.tenantId, tenantId)).orderBy(asc(notificationRules.subject), asc(notificationRules.kind), asc(notificationRules.createdAt));
  return rows.map(ruleVm);
}

export interface UpdateRuleInput {
  enabled?: boolean;
  offsetValue?: number;
  offsetUnit?: NotificationOffsetUnit;
  templateId?: string | null;
  minGapMinutes?: number;
}

export async function updateRule(db: Db, tenantId: string, id: string, input: UpdateRuleInput): Promise<Result<{ rule: NotificationRuleVm }>> {
  const [existing] = await db.select().from(notificationRules).where(and(eq(notificationRules.tenantId, tenantId), eq(notificationRules.id, id))).limit(1);
  if (!existing) return { ok: false, reason: "rule_not_found" };
  if (existing.kind === "CONFIRMATION" && (input.offsetValue !== undefined || input.offsetUnit !== undefined)) return { ok: false, reason: "confirmation_has_no_offset" };
  if (input.offsetValue !== undefined && (!Number.isInteger(input.offsetValue) || input.offsetValue < 1 || input.offsetValue > 10_000)) return { ok: false, reason: "invalid_offset" };
  if (input.minGapMinutes !== undefined && (!Number.isInteger(input.minGapMinutes) || input.minGapMinutes < 0 || input.minGapMinutes > 10_080)) return { ok: false, reason: "invalid_gap" };
  if (input.templateId) {
    const [t] = await db.select().from(messageTemplates).where(and(eq(messageTemplates.tenantId, tenantId), eq(messageTemplates.id, input.templateId))).limit(1);
    if (!t || t.purpose !== purposeForRule(existing.subject, existing.kind)) return { ok: false, reason: "template_mismatch" };
  }
  const [row] = await db
    .update(notificationRules)
    .set({
      enabled: input.enabled ?? existing.enabled,
      offsetValue: input.offsetValue ?? existing.offsetValue,
      offsetUnit: input.offsetUnit ?? existing.offsetUnit,
      templateId: input.templateId === undefined ? existing.templateId : input.templateId,
      minGapMinutes: input.minGapMinutes ?? existing.minGapMinutes,
      updatedAt: new Date(),
    })
    .where(eq(notificationRules.id, id))
    .returning();
  // Switching a rule off also withdraws what it has already queued (the worker re-checks too, for the race window).
  if (existing.enabled && input.enabled === false) {
    await db
      .update(notifications)
      .set({ status: "CANCELLED", reason: "RULE_DISABLED" })
      .where(and(eq(notifications.tenantId, tenantId), eq(notifications.ruleId, id), eq(notifications.status, "PENDING")));
  }
  return { ok: true, rule: ruleVm(row!) };
}

// ---------------------------------------------------------------------------
// Subject context (what a message is about), loaded fresh every time
// ---------------------------------------------------------------------------

export interface SubjectContext {
  type: "APPOINTMENT" | "SURGERY";
  id: string;
  patientId: string;
  journeyId: string | null;
  phone: string | null;
  start: Date | null;
  /** The visit/surgery is no longer something to remind about (cancelled, completed, no-show, not scheduled). */
  inactiveReason: string | null;
  /** Appointment status (appointments only): messages are planned for a CONFIRMED visit. */
  status?: string;
  values: Record<string, string>;
}

const fmtDate = (d: Date, tz: string) => new Intl.DateTimeFormat("en-IN", { timeZone: tz, day: "numeric", month: "short", year: "numeric" }).format(d);
const fmtTime = (d: Date, tz: string) => new Intl.DateTimeFormat("en-IN", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(d).toUpperCase();

export async function loadSubjectContext(db: Db, tenantId: string, type: "APPOINTMENT" | "SURGERY", id: string): Promise<SubjectContext | null> {
  const [tenant] = await db.select({ name: tenants.name, timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) return null;
  if (type === "APPOINTMENT") {
    const [row] = await db
      .select({ a: appointments, patientName: patients.name, phone: patients.phoneE164, rawPhone: patients.phone, branch: branches.name, doctor: scheduleResources.name })
      .from(appointments)
      .innerJoin(patients, eq(patients.id, appointments.patientId))
      .innerJoin(branches, eq(branches.id, appointments.branchId))
      .leftJoin(scheduleResources, eq(scheduleResources.id, appointments.resourceId))
      .where(and(eq(appointments.tenantId, tenantId), eq(appointments.id, id)))
      .limit(1);
    if (!row) return null;
    const active = ["requested", "scheduled", "confirmed"].includes(row.a.status);
    return {
      type, id, patientId: row.a.patientId, journeyId: row.a.journeyId, phone: row.phone ?? null, start: row.a.scheduledAt, status: row.a.status,
      inactiveReason: active ? null : row.a.status === "cancelled" ? "APPOINTMENT_CANCELLED" : row.a.status === "no_show" ? "NO_SHOW" : "APPOINTMENT_NOT_UPCOMING",
      values: {
        patient_name: row.patientName?.trim() || "there",
        doctor_name: row.doctor ?? "your doctor",
        date: fmtDate(row.a.scheduledAt, tenant.timezone),
        time: fmtTime(row.a.scheduledAt, tenant.timezone),
        branch_name: row.branch,
        hospital_name: tenant.name,
      },
    };
  }
  const [row] = await db
    .select({ t: treatmentOpportunities, patientName: patients.name, phone: patients.phoneE164, branchScheduled: sql<string | null>`(select name from branches where id = ${treatmentOpportunities.scheduledBranchId})` })
    .from(treatmentOpportunities)
    .innerJoin(patients, eq(patients.id, treatmentOpportunities.patientId))
    .where(and(eq(treatmentOpportunities.tenantId, tenantId), eq(treatmentOpportunities.id, id)))
    .limit(1);
  if (!row) return null;
  const planned = row.t.plannedDate;
  return {
    type, id, patientId: row.t.patientId, journeyId: row.t.journeyId, phone: row.phone ?? null, start: planned,
    inactiveReason: row.t.status !== "SCHEDULED" ? "APPOINTMENT_CANCELLED" : !planned ? "NOT_SCHEDULED" : null,
    values: {
      patient_name: row.patientName?.trim() || "there",
      procedure: row.t.treatmentLabel,
      date: planned ? fmtDate(planned, tenant.timezone) : "",
      time: planned ? fmtTime(planned, tenant.timezone) : "",
      branch_name: row.branchScheduled ?? "",
      hospital_name: tenant.name,
    },
  };
}

// ---------------------------------------------------------------------------
// Planning from domain events
// ---------------------------------------------------------------------------

export async function cancelPendingForSubject(db: Db, tenantId: string, type: string, id: string, reason: string, opts: { exceptSubjectAt?: Date } = {}): Promise<number> {
  const rows = await db
    .update(notifications)
    .set({ status: "CANCELLED", reason })
    .where(and(eq(notifications.tenantId, tenantId), eq(notifications.subjectType, type), eq(notifications.subjectId, id), inArray(notifications.status, ["PENDING", "PROCESSING"]),
      ...(opts.exceptSubjectAt ? [sql`${notifications.subjectAt} is distinct from ${opts.exceptSubjectAt.toISOString()}::timestamptz`] : [])))
    .returning({ id: notifications.id });
  return rows.length;
}

/**
 * (Re)build the notifications for one visit/surgery from the tenant's rules. Safe to call any number of times: the
 * unique idempotency key means a repeat adds nothing. Does nothing unless the hospital has WhatsApp Notifications on.
 */
export interface PlanOptions {
  /** Fill gaps only: a cancelled notification is never brought back (the event paths revive, the safety-net pass must not). */
  onlyGaps?: boolean;
  /** false: leave the immediate confirmation out (reminders only). */
  confirmations?: boolean;
}

export async function planForSubject(db: Db, tenantId: string, type: "APPOINTMENT" | "SURGERY", id: string, now: Date = new Date(), opts: PlanOptions = {}): Promise<{ planned: number; suppressed: string[] }> {
  const caps = await tenantCapabilityMap(db, tenantId);
  if (!caps.WHATSAPP_NOTIFICATIONS) return { planned: 0, suppressed: [] };
  await ensureNotificationDefaults(db, tenantId);
  const ctx = await loadSubjectContext(db, tenantId, type, id);
  if (!ctx || !ctx.start) return { planned: 0, suppressed: [] };
  if (type === "APPOINTMENT" && ctx.status !== "confirmed" && !ctx.inactiveReason) return { planned: 0, suppressed: ["NOT_CONFIRMED"] };

  const ruleRows = await db.select().from(notificationRules).where(and(eq(notificationRules.tenantId, tenantId), eq(notificationRules.subject, type)));
  const rules: PlanRule[] = ruleRows.map((r) => ({ id: r.id, kind: r.kind as PlanRule["kind"], enabled: r.enabled, offsetValue: r.offsetValue, offsetUnit: r.offsetUnit as NotificationOffsetUnit, minGapMinutes: r.minGapMinutes }));

  const rows = await db.select({ key: notifications.idempotencyKey, status: notifications.status, scheduledFor: notifications.scheduledFor, subjectAt: notifications.subjectAt }).from(notifications).where(and(eq(notifications.tenantId, tenantId), eq(notifications.subjectType, type), eq(notifications.subjectId, id)));
  // A rule is settled for this exact visit time once its notification exists and was not cancelled; a cancelled one (the visit
  // moved away and came back) may be planned again. Settled ones still count toward the minimum gap.
  const settled = new Set(rows.filter((r) => opts.onlyGaps || r.status !== "CANCELLED").map((r) => r.key));
  const existing = rows.filter((r) => r.subjectAt?.getTime() === ctx.start!.getTime() && ["PENDING", "PROCESSING", "SENT", "DELIVERED", "READ"].includes(r.status));
  const open = rules.filter((r) => !settled.has(notificationKey(r.id, id, ctx.start!)) && (opts.confirmations !== false || r.kind !== "CONFIRMATION"));

  const plan = planNotifications({ start: ctx.start, now, rules: open, cancelled: !!ctx.inactiveReason, alreadyScheduled: existing.map((e) => e.scheduledFor) });
  let planned = 0;
  for (const p of plan.planned) {
    const rule = ruleRows.find((r) => r.id === p.ruleId)!;
    const inserted = await db
      .insert(notifications)
      .values({ tenantId, ruleId: rule.id, templateId: rule.templateId, subjectType: type, subjectId: id, patientId: ctx.patientId, journeyId: ctx.journeyId, subjectAt: ctx.start, scheduledFor: p.triggerAt, idempotencyKey: notificationKey(rule.id, id, ctx.start) })
      .onConflictDoUpdate({ target: [notifications.tenantId, notifications.idempotencyKey], set: { status: "PENDING", reason: null, attempts: 0, scheduledFor: p.triggerAt, templateId: rule.templateId }, setWhere: eq(notifications.status, "CANCELLED") })
      .returning({ id: notifications.id });
    planned += inserted.length;
  }
  return { planned, suppressed: plan.suppressed.map((s) => `${s.ruleId}:${s.reason}`) };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface SendDeps {
  adapterFor?: (provider: string) => MessagingProviderAdapter | null;
  fetchImpl?: typeof fetch;
}

export async function getWhatsNexusWebhook(db: Db, tenantId: string) {
  const [webhook] = await db
    .select()
    .from(outboundWebhooks)
    .where(
      and(
        eq(outboundWebhooks.tenantId, tenantId),
        eq(outboundWebhooks.enabled, true),
        or(
          eq(outboundWebhooks.webhookCategory, "WHATSNEXUS"),
          sql`${outboundWebhooks.events} @> ARRAY['whatsapp.followup_requested']::text[]`,
        ),
      ),
    )
    .limit(1);
  return webhook ?? null;
}

type Row = typeof notifications.$inferSelect;

async function finish(db: Db, id: string, patch: Partial<typeof notifications.$inferInsert>): Promise<void> {
  // Only a row that is still being processed may be finished: a late writer can never overwrite a CANCELLED or reclaimed row.
  await db.update(notifications).set(patch).where(and(eq(notifications.id, id), eq(notifications.status, "PROCESSING")));
}

/** Bookkeeping after the provider ACCEPTED a message: retried, and never allowed to turn a delivered message into a resend. */
async function recordAfterSend(db: Db, n: Row, connectorId: string, tenantId: string, now: Date, patch: Partial<typeof notifications.$inferInsert>): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try {
      await finish(db, n.id, patch);
      break;
    } catch (err) {
      if (i === 2) console.error("could not record a sent notification", n.id, err);
    }
  }
  try {
    await db.insert(connectorEvents).values({ tenantId, connectorId, externalEventId: `notification:${n.id}:${n.attempts}`, direction: "outbound", status: "processed", payload: { type: "notification" }, processedAt: now }).onConflictDoNothing();
    await touchConnectorSuccess(db, connectorId);
  } catch (err) {
    console.error("could not log a sent notification", n.id, err);
  }
}

/** Resolve the connector/adapter/template and send ONE notification row that is already claimed (PROCESSING). */
async function sendClaimed(db: Db, n: Row, now: Date, deps: SendDeps): Promise<"sent" | "blocked" | "cancelled" | "retry" | "failed"> {
  const tenantId = n.tenantId;
  const caps = await tenantCapabilityMap(db, tenantId);
  if (!caps.WHATSAPP_NOTIFICATIONS) return (await finish(db, n.id, { status: "BLOCKED", reason: "CAPABILITY_DISABLED" }), "blocked");

  // A reminder follows its rule: one switched off (or removed) after this was queued is not sent. Staff-sent messages
  // (FOLLOW_UP) belong to no rule.
  if (n.ruleId && n.subjectType !== "FOLLOW_UP") {
    const [rule] = await db.select({ enabled: notificationRules.enabled }).from(notificationRules).where(eq(notificationRules.id, n.ruleId)).limit(1);
    if (!rule?.enabled) return (await finish(db, n.id, { status: "CANCELLED", reason: "RULE_DISABLED" }), "cancelled");
  }

  // Re-check the world as it is now: a visit that moved, was cancelled or has already happened is never reminded about.
  let patientPhone: string | null;
  let values: Record<string, string>;
  if (n.subjectType === "FOLLOW_UP") {
    const mc = n.journeyId && n.createdBy ? await manualContext(db, tenantId, n.journeyId, n.createdBy) : null;
    patientPhone = mc?.phone ?? null;
    values = mc?.values ?? {};
  } else {
    const ctx = await loadSubjectContext(db, tenantId, n.subjectType as "APPOINTMENT" | "SURGERY", n.subjectId);
    if (!ctx) return (await finish(db, n.id, { status: "CANCELLED", reason: "SUBJECT_GONE" }), "cancelled");
    if (ctx.inactiveReason) return (await finish(db, n.id, { status: "CANCELLED", reason: ctx.inactiveReason }), "cancelled");
    // Messages follow CONFIRMED: a visit that is not (or is no longer) confirmed never gets one, whatever was planned earlier.
    if (n.subjectType === "APPOINTMENT" && ctx.status !== "confirmed") return (await finish(db, n.id, { status: "CANCELLED", reason: "NOT_CONFIRMED" }), "cancelled");
    if (n.subjectAt && ctx.start && ctx.start.getTime() !== n.subjectAt.getTime()) return (await finish(db, n.id, { status: "CANCELLED", reason: "RESCHEDULED" }), "cancelled");
    if (ctx.start && ctx.start.getTime() <= now.getTime()) return (await finish(db, n.id, { status: "CANCELLED", reason: "TRIGGER_ALREADY_PASSED" }), "cancelled");
    // A reminder is never sent late: after downtime or a backlog its moment has gone (retries of one already tried are exempt).
    if (n.attempts <= 1 && now.getTime() - n.scheduledFor.getTime() > LATE_GRACE_MS) return (await finish(db, n.id, { status: "CANCELLED", reason: "TRIGGER_ALREADY_PASSED" }), "cancelled");
    patientPhone = ctx.phone;
    values = ctx.values;
  }
  if (!patientPhone) return (await finish(db, n.id, { status: "BLOCKED", reason: "NO_VALID_PHONE" }), "blocked");

  const [template] = n.templateId ? await db.select().from(messageTemplates).where(eq(messageTemplates.id, n.templateId)).limit(1) : [];
  if (!template || !template.enabled) return (await finish(db, n.id, { status: "BLOCKED", reason: "TEMPLATE_UNAVAILABLE" }), "blocked");

  const connector = await getConnectorByTenantAndProvider(db, tenantId, WA_PROVIDER);
  const adapter = (deps.adapterFor ?? getMessagingAdapter)(WA_PROVIDER);
  if (!connector || !adapter || connector.status === "DISABLED") {
    const whatsNexus = await getWhatsNexusWebhook(db, tenantId);
    if (!whatsNexus) return (await finish(db, n.id, { status: "BLOCKED", reason: "PROVIDER_NOT_CONFIGURED" }), "blocked");

    const rendered = n.renderedText ? { text: n.renderedText, missing: [] as string[] } : renderTemplate(template.body, values);
    if (rendered.missing.length > 0) return (await finish(db, n.id, { status: "BLOCKED", reason: "MISSING_VARIABLES" }), "blocked");

    const fullUrl = buildFullWebhookUrl(whatsNexus.url, whatsNexus.endpointPath);
    const targetCheck = validateWebhookUrl(fullUrl, { allowInsecure: allowInsecure() });
    if (!targetCheck.ok) {
      await finish(db, n.id, { status: "FAILED", reason: `INVALID_WEBHOOK_URL: ${targetCheck.reason}` });
      return "failed";
    }

    const context: Record<string, unknown> = {
      call_Id: n.journeyId ?? n.id,
      journeyId: n.journeyId ?? n.id,
      customerName: values.patient_name,
      patientName: values.patient_name,
      phoneNumber: patientPhone,
      phone: patientPhone,
      patientPhone: patientPhone,
      agentName: values.staff_name ?? values.doctor_name,
      staffName: values.staff_name ?? values.doctor_name,
      createdAt: now.toISOString(),
      status: "OPEN",
      typeOfEnquiry: "Follow-up",
      source: "PULSE_OS",
      templateName: template.name,
      message: rendered.text,
      hospitalName: values.hospital_name,
      notificationId: n.id,
    };

    let payload: Record<string, unknown>;
    const mappings = whatsNexus.payloadMapping as Array<{ key: string; field: string; fallbackValue?: string | null }> | null;
    if (Array.isArray(mappings) && mappings.length > 0) {
      payload = resolveDynamicPayload(mappings, context);
    } else {
      payload = {
        call_Id: n.journeyId ?? n.id,
        customerName: values.patient_name,
        phoneNumber: patientPhone,
        agentName: values.staff_name ?? values.doctor_name,
        createdAt: now.toISOString(),
        status: "OPEN",
        typeOfEnquiry: "Follow-up",
        source: "PULSE_OS",
        templateName: template.name,
        message: rendered.text,
      };
    }

    const customHeaders: Record<string, string> = {};
    if (Array.isArray(whatsNexus.headers)) {
      for (const h of whatsNexus.headers as Array<{ key: string; value: string }>) {
        if (h.key && h.value) customHeaders[h.key] = h.value;
      }
    }

    let providerMessageId = `whatsnexus_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      const fetchFn = deps.fetchImpl ?? (fetch as typeof fetch);
      const res = await fetchFn(targetCheck.url, {
        method: whatsNexus.httpMethod || "POST",
        headers: {
          "content-type": "application/json",
          "x-pulseos-notification-id": n.id,
          ...customHeaders,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });

      if (res.status >= 300) {
        const errText = await res.text().catch(() => "");
        throw new Error(`WhatsNexus returned HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }

      const resJson = (await res.json().catch(() => null)) as any;
      if (resJson && typeof resJson === "object") {
        if (resJson.messageId || resJson.id || resJson.call_Id) {
          providerMessageId = String(resJson.messageId || resJson.id || resJson.call_Id);
        }
      }
    } catch (err) {
      const message = redactLogText(err instanceof Error ? err.message : String(err)) ?? "send failed";
      await finish(db, n.id, { status: "FAILED", reason: message });
      return "failed";
    }

    await db.update(notifications).set({ status: "SENT", providerMessageId, renderedText: rendered.text, sentAt: now, reason: null }).where(eq(notifications.id, n.id));
    emitIntegrationEvent({
      type: "whatsapp.followup_requested",
      tenantId,
      eventId: `whatsapp.followup:${n.id}`,
      occurredAt: now,
      data: {
        notificationId: n.id,
        journeyId: n.journeyId,
        patientId: n.patientId,
        phoneNumber: patientPhone,
        templateName: template.name,
        provider: "whatsnexus",
      },
    });
    return "sent";
  }

  const rendered = n.renderedText ? { text: n.renderedText, missing: [] as string[] } : renderTemplate(template.body, values);
  if (rendered.missing.length > 0) return (await finish(db, n.id, { status: "BLOCKED", reason: "MISSING_VARIABLES" }), "blocked");

  const config = { ...((connector.configuration as Record<string, unknown> | null) ?? {}), mode: connector.mode.toLowerCase() };
  const secrets = connector.mode === "FIXTURE" ? {} : (await getConnectorSecrets(db, connector.id)) ?? {};
  let providerMessageId: string;
  try {
    const res = await adapter.sendTemplate(config, secrets, patientPhone, { name: template.providerTemplateName, language: template.language, parameters: templateParameters(template.body, values) });
    providerMessageId = res.providerMessageId;
  } catch (err) {
    const message = redactLogText(err instanceof Error ? err.message : String(err)) ?? "send failed";
    await db.insert(connectorEvents).values({ tenantId, connectorId: connector.id, externalEventId: `notification:${n.id}:${n.attempts}`, direction: "outbound", status: "failed", error: message, payload: { type: "notification" } }).onConflictDoNothing();
    await touchConnectorError(db, connector.id, message);
    const delay = RETRY_DELAYS_MS[n.attempts - 1];
    // A message a person chose to send is never retried behind their back (they saw it fail and decide what to do).
    if (err instanceof AmbiguousSendError || n.subjectType === "FOLLOW_UP" || n.attempts >= MAX_SEND_ATTEMPTS || delay === undefined) {
      await finish(db, n.id, { status: "FAILED", reason: message });
      return "failed";
    }
    await finish(db, n.id, { status: "PENDING", reason: message, scheduledFor: new Date(now.getTime() + delay) });
    return "retry";
  }
  // The provider has the message. Nothing below may route into the retry path.
  await recordAfterSend(db, n, connector.id, tenantId, now, { status: "SENT", providerMessageId, renderedText: rendered.text, sentAt: now, reason: null });
  return "sent";
}

/** The worker tick: send everything due, once. Claiming first means two workers (or a repeated tick) can never double-send. */
export async function processDueNotifications(db: Db, now: Date, deps: SendDeps = {}): Promise<Record<string, number>> {
  // A worker that died mid-send leaves PROCESSING rows; after a grace period they are marked failed (never re-sent).
  // Not back to PENDING: the provider may already have the message, and a resend (or a late staff send) is worse than a visible failure.
  await db.update(notifications).set({ status: "FAILED", reason: "SEND_INTERRUPTED" }).where(and(eq(notifications.status, "PROCESSING"), lt(notifications.processingStartedAt, new Date(now.getTime() - STALE_PROCESSING_MS))));

  const due = await db.select({ id: notifications.id }).from(notifications).where(and(eq(notifications.status, "PENDING"), lte(notifications.scheduledFor, now))).orderBy(asc(notifications.scheduledFor)).limit(50);
  const tally: Record<string, number> = { sent: 0, blocked: 0, cancelled: 0, retry: 0, failed: 0 };
  for (const { id } of due) {
    const [claimed] = await db
      .update(notifications)
      .set({ status: "PROCESSING", attempts: sql`${notifications.attempts} + 1`, processingStartedAt: now })
      .where(and(eq(notifications.id, id), eq(notifications.status, "PENDING")))
      .returning();
    if (!claimed) continue;
    try {
      tally[await sendClaimed(db, claimed, now, deps)]!++;
    } catch (err) {
      await finish(db, id, { status: "FAILED", reason: redactLogText(err instanceof Error ? err.message : String(err)) });
      tally.failed!++;
    }
  }
  return tally;
}

// ---------------------------------------------------------------------------
// Delivery status from the provider (monotonic: a status never moves backwards)
// ---------------------------------------------------------------------------

const RANK: Record<string, number> = { PENDING: 0, PROCESSING: 1, SENT: 2, DELIVERED: 3, READ: 4 };

/** `tenantId` is the connector's tenant: a status event can only ever touch that hospital's own messages. */
export async function applyDeliveryStatus(db: Db, tenantId: string, providerMessageId: string, status: "sent" | "delivered" | "read" | "failed", at: Date): Promise<boolean> {
  const [n] = await db.select().from(notifications).where(and(eq(notifications.tenantId, tenantId), eq(notifications.providerMessageId, providerMessageId))).limit(1);
  if (!n) return false;
  // Provider status updates are not part of a send: they apply to a row in whatever state it has reached.
  const update = (patch: Partial<typeof notifications.$inferInsert>) => db.update(notifications).set(patch).where(eq(notifications.id, n.id));
  if (status === "failed") {
    if (n.status === "SENT" || n.status === "PROCESSING") await update({ status: "FAILED", reason: "PROVIDER_REPORTED_FAILURE" });
    return true;
  }
  const next = status.toUpperCase();
  if ((RANK[next] ?? 0) <= (RANK[n.status] ?? 0)) return true;
  await update({ status: next, ...(next === "DELIVERED" ? { deliveredAt: at } : {}), ...(next === "READ" ? { readAt: at, ...(n.deliveredAt ? {} : { deliveredAt: at }) } : {}) });
  return true;
}

// ---------------------------------------------------------------------------
// Staff: send a WhatsApp message from a follow-up
// ---------------------------------------------------------------------------

async function manualContext(db: Db, tenantId: string, journeyId: string, actorId: string) {
  const [row] = await db
    .select({ journeyId: sql<string>`j.id`, patientId: patients.id, name: patients.name, phone: patients.phoneE164, raw: patients.phone })
    .from(sql`journeys j`)
    .innerJoin(patients, sql`${patients.id} = j.patient_id`)
    .where(sql`j.tenant_id = ${tenantId} and j.id = ${journeyId}`)
    .limit(1);
  if (!row) return null;
  const [tenant] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const [staff] = await db.select({ name: users.name }).from(users).where(eq(users.id, actorId)).limit(1);
  return { ...row, values: { patient_name: row.name?.trim() || "there", staff_name: staff?.name ?? "our team", hospital_name: tenant?.name ?? "" } };
}

const maskPhone = (p: string) => (p.length > 5 ? `${p.slice(0, 3)}${"•".repeat(Math.max(0, p.length - 5))}${p.slice(-2)}` : "•••");

export async function previewFollowUpMessage(db: Db, tenantId: string, actorId: string, journeyId: string): Promise<Result<{ preview: WhatsAppPreview }>> {
  const caps = await tenantCapabilityMap(db, tenantId);
  if (!caps.WHATSAPP_NOTIFICATIONS) return { ok: false, reason: "feature_not_available" };
  await ensureNotificationDefaults(db, tenantId);
  const ctx = await manualContext(db, tenantId, journeyId, actorId);
  if (!ctx) return { ok: false, reason: "journey_not_found" };
  const [template] = await db.select().from(messageTemplates).where(and(eq(messageTemplates.tenantId, tenantId), eq(messageTemplates.purpose, "FOLLOW_UP_MESSAGE"))).limit(1);
  if (!template) return { ok: false, reason: "template_not_found" };
  const rendered = renderTemplate(template.body, ctx.values);
  const connector = await getConnectorByTenantAndProvider(db, tenantId, WA_PROVIDER);
  const whatsNexus = await getWhatsNexusWebhook(db, tenantId);
  const hasProvider = (connector && connector.status !== "DISABLED") || !!whatsNexus;
  const blockedReason = !template.enabled ? "TEMPLATE_UNAVAILABLE" : !ctx.phone ? "NO_VALID_PHONE" : !hasProvider ? "PROVIDER_NOT_CONFIGURED" : rendered.missing.length ? "MISSING_VARIABLES" : null;
  return { ok: true, preview: { recipient: ctx.phone ? maskPhone(ctx.phone) : "No valid number", text: rendered.text, templateName: template.name, missingVariables: rendered.missing, canSend: blockedReason === null, blockedReason } };
}

/**
 * A person chose to send this message. It goes through the same durable path as every other notification (one row, the same
 * adapter, the same status tracking), is recorded on the Journey timeline, and never completes the follow-up task.
 */
export async function sendFollowUpMessage(db: Db, tenantId: string, actorId: string, journeyId: string, idempotencyKey: string, deps: SendDeps = {}, now: Date = new Date()): Promise<Result<{ notificationId: string; status: string; duplicate: boolean }>> {
  const preview = await previewFollowUpMessage(db, tenantId, actorId, journeyId);
  if (!preview.ok) return preview;
  if (!preview.preview.canSend) return { ok: false, reason: preview.preview.blockedReason ?? "cannot_send" };
  const ctx = (await manualContext(db, tenantId, journeyId, actorId))!;
  const [template] = await db.select().from(messageTemplates).where(and(eq(messageTemplates.tenantId, tenantId), eq(messageTemplates.purpose, "FOLLOW_UP_MESSAGE"))).limit(1);

  const key = `followup:${journeyId}:${idempotencyKey}`;
  const [inserted] = await db
    .insert(notifications)
    .values({ tenantId, templateId: template!.id, subjectType: "FOLLOW_UP", subjectId: journeyId, patientId: ctx.patientId, journeyId, scheduledFor: now, renderedText: preview.preview.text, idempotencyKey: key, createdBy: actorId })
    .onConflictDoNothing()
    .returning();
  if (!inserted) {
    const [existing] = await db.select().from(notifications).where(and(eq(notifications.tenantId, tenantId), eq(notifications.idempotencyKey, key))).limit(1);
    return { ok: true, notificationId: existing!.id, status: existing!.status, duplicate: true };
  }
  const [claimed] = await db.update(notifications).set({ status: "PROCESSING", attempts: 1, processingStartedAt: now }).where(and(eq(notifications.id, inserted.id), eq(notifications.status, "PENDING"))).returning();
  const outcome = claimed ? await sendClaimed(db, claimed, now, deps) : "cancelled";
  const [after] = await db.select().from(notifications).where(eq(notifications.id, inserted.id)).limit(1);
  if (outcome === "sent") {
    await db.insert(timelineEvents).values({
      tenantId, patientId: ctx.patientId, journeyId, actorType: "user", actorId, eventType: "whatsapp_sent", channel: "WHATSAPP",
      title: "WhatsApp message sent", description: after!.renderedText, relatedEntityType: "notification", relatedEntityId: inserted.id, occurredAt: now,
    });
  }
  return { ok: true, notificationId: inserted.id, status: after!.status, duplicate: false };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listNotificationsFor(db: Db, tenantId: string, type: string, id: string): Promise<NotificationVm[]> {
  const rows = await db.select({ n: notifications, purpose: messageTemplates.purpose }).from(notifications).leftJoin(messageTemplates, eq(messageTemplates.id, notifications.templateId))
    .where(and(eq(notifications.tenantId, tenantId), eq(notifications.subjectType, type), eq(notifications.subjectId, id))).orderBy(desc(notifications.scheduledFor));
  return rows.map(({ n, purpose }) => ({ id: n.id, subject: n.subjectType as NotificationVm["subject"], subjectId: n.subjectId, status: n.status as NotificationVm["status"], reason: n.reason, scheduledFor: n.scheduledFor.toISOString(), sentAt: n.sentAt?.toISOString() ?? null, templatePurpose: (purpose as TemplatePurpose | null) ?? null }));
}
