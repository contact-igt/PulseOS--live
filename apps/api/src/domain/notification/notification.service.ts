import { and, asc, desc, eq, gte, inArray, isNull, like, lt, lte, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { appointments, branches, connectorEvents, conversations, messages, messageTemplates, notificationRules, notifications, patients, scheduleResources, tenants, timelineEvents, treatmentOpportunities, users } from "../../db/schema.js";
import { TEMPLATE_VARIABLES, checkProviderTemplate, type WhatsAppDelivery, type MessageTemplateVm, type NotificationOffsetUnit, type NotificationRuleVm, type NotificationSubject, type NotificationVm, type TemplatePurpose, type WhatsAppPreview } from "@pulseos/types";
import { tenantCapabilityMap } from "../capability/capability.service.js";
import { getConnectorByTenantAndProvider, getConnectorSecrets, touchConnectorError, touchConnectorSuccess } from "../connector/connector.service.js";
import { getMessagingAdapter } from "../connector/registry.js";
import { AmbiguousSendError, PermanentSendError, RetryableSendError, type MessagingProviderAdapter } from "../connector/types.js";
import { redactLogText } from "../security/redact.js";
import { recordConversationActivity } from "../conversation/summary/conversation-session.service.js";
import { DEFAULT_RULES, notificationKey, planNotifications, type PlanRule } from "./notification-plan.js";
import { fetchProviderTemplateCatalogue, validateAgainstProvider, type CatalogueDeps } from "./provider-templates.js";
import { DEFAULT_TEMPLATES, renderTemplate, templateParameters, validateTemplateBody, variablesUsed } from "./message-template.js";

type Result<T> = ({ ok: true } & T) | { ok: false; reason: string };

export const MAX_SEND_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [2 * 60_000, 10 * 60_000];
const STALE_PROCESSING_MS = 5 * 60_000;
/** How long after its moment a planned reminder may still go out (the worker ticks every 30 s). */
const LATE_GRACE_MS = 15 * 60_000;
const META_PROVIDER = "whatsapp_meta_cloud";
export const WHATSNEXUS_PROVIDER = "whatsnexus";

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

export type UpdateTemplateResult = Result<{ template: MessageTemplateVm }> | { ok: false; reason: "template_incompatible" | "catalogue_unavailable"; detail: { code: string; message: string } };

export async function updateTemplate(db: Db, tenantId: string, id: string, input: UpdateTemplateInput, deps: CatalogueDeps = {}): Promise<UpdateTemplateResult> {
  const [existing] = await db.select().from(messageTemplates).where(and(eq(messageTemplates.tenantId, tenantId), eq(messageTemplates.id, id))).limit(1);
  if (!existing) return { ok: false, reason: "template_not_found" };
  if (input.body !== undefined) {
    if (!input.body.trim() || input.body.length > 1024) return { ok: false, reason: "invalid_body" };
    const check = validateTemplateBody(existing.purpose as TemplatePurpose, input.body);
    if (!check.ok) return { ok: false, reason: "unknown_variable" };
  }
  // When WhatsNexus is the sender, what will actually be sent (template name, language, number of variables) must be one it has
  // approved. Checked whenever any of those change, and when a template is switched ON, against a fresh read of its catalogue.
  if (input.providerTemplateName !== undefined || input.language !== undefined || input.body !== undefined || input.enabled === true) {
    const provider = await validateAgainstProvider(db, tenantId, {
      providerTemplateName: input.providerTemplateName?.trim() || existing.providerTemplateName,
      language: input.language?.trim() || existing.language,
      body: input.body ?? existing.body,
    }, deps);
    if (!provider.ok) return provider;
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

/** Queue one immediate appointment-change message. Its event key makes repeated delivery of the same domain event harmless. */
export async function queueAppointmentChange(db: Db, tenantId: string, appointmentId: string, purpose: "APPOINTMENT_RESCHEDULED" | "APPOINTMENT_CANCELLED", now: Date = new Date()): Promise<number> {
  const caps = await tenantCapabilityMap(db, tenantId);
  if (!caps.WHATSAPP_NOTIFICATIONS) return 0;
  await ensureNotificationDefaults(db, tenantId);
  const ctx = await loadSubjectContext(db, tenantId, "APPOINTMENT", appointmentId);
  if (!ctx || !ctx.start) return 0;
  const [template] = await db.select({ id: messageTemplates.id }).from(messageTemplates).where(and(eq(messageTemplates.tenantId, tenantId), eq(messageTemplates.purpose, purpose))).limit(1);
  if (!template) return 0;
  const key = `appointment-change:${purpose}:${appointmentId}:${ctx.start.getTime()}`;
  const inserted = await db.insert(notifications).values({ tenantId, templateId: template.id, subjectType: "APPOINTMENT", subjectId: appointmentId, patientId: ctx.patientId, journeyId: ctx.journeyId, subjectAt: ctx.start, scheduledFor: now, idempotencyKey: key }).onConflictDoNothing().returning({ id: notifications.id });
  return inserted.length;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface SendDeps {
  adapterFor?: (provider: string) => MessagingProviderAdapter | null;
  fetchImpl?: typeof fetch;
}

export type SendProviderChoice =
  | { ok: true; provider: string; connector: NonNullable<Awaited<ReturnType<typeof getConnectorByTenantAndProvider>>>; adapter: MessagingProviderAdapter }
  | { ok: false; reason: "PROVIDER_NOT_CONFIGURED" | "PROVIDER_NOT_READY" };

/**
 * Exactly ONE sending provider per notification, chosen explicitly:
 *  - WhatsNexus only when its connector is switched on for sending (configuration.useForSending === "true"), is not
 *    disabled and is in LIVE mode. If it is selected but not usable the message is BLOCKED — it never falls back to Meta.
 *  - Otherwise Meta Cloud, exactly as before (existing hospitals are unchanged by default).
 */
export async function resolveSendProvider(db: Db, tenantId: string, adapterFor: (provider: string) => MessagingProviderAdapter | null = getMessagingAdapter): Promise<SendProviderChoice> {
  const wn = await getConnectorByTenantAndProvider(db, tenantId, WHATSNEXUS_PROVIDER);
  const wnConfig = (wn?.configuration as Record<string, unknown> | null) ?? {};
  if (wn && String(wnConfig.useForSending ?? "") === "true") {
    const adapter = adapterFor(WHATSNEXUS_PROVIDER);
    if (!adapter || wn.status === "DISABLED" || wn.mode !== "LIVE") return { ok: false, reason: "PROVIDER_NOT_READY" };
    return { ok: true, provider: WHATSNEXUS_PROVIDER, connector: wn, adapter };
  }
  const connector = await getConnectorByTenantAndProvider(db, tenantId, META_PROVIDER);
  const adapter = adapterFor(META_PROVIDER);
  if (!connector || !adapter || connector.status === "DISABLED") return { ok: false, reason: "PROVIDER_NOT_CONFIGURED" };
  return { ok: true, provider: META_PROVIDER, connector, adapter };
}

type Row = typeof notifications.$inferSelect;

async function finish(db: Db, id: string, patch: Partial<typeof notifications.$inferInsert>): Promise<void> {
  // Only a row that is still being processed may be finished: a late writer can never overwrite a CANCELLED or reclaimed row.
  await db.update(notifications).set(patch).where(and(eq(notifications.id, id), eq(notifications.status, "PROCESSING")));
}

/**
 * The provider accepted the message. Normally the row is still PROCESSING and becomes SENT. A fast delivery callback (or a
 * reconciliation) may already have moved it on, in which case its status is kept and only the missing facts are filled in.
 */
async function finishAfterSend(db: Db, id: string, patch: Partial<typeof notifications.$inferInsert>): Promise<void> {
  const moved = await db.update(notifications).set(patch).where(and(eq(notifications.id, id), eq(notifications.status, "PROCESSING"))).returning({ id: notifications.id });
  if (moved.length > 0) return;
  await db
    .update(notifications)
    .set({
      providerMessageId: sql`coalesce(${notifications.providerMessageId}, ${patch.providerMessageId ?? null}::text)`,
      renderedText: sql`coalesce(${notifications.renderedText}, ${patch.renderedText ?? null}::text)`,
      // A Date cannot be bound inside a raw fragment: pass an ISO string with an explicit type.
      sentAt: sql`coalesce(${notifications.sentAt}, ${patch.sentAt instanceof Date ? patch.sentAt.toISOString() : null}::timestamptz)`,
    })
    .where(and(eq(notifications.id, id), inArray(notifications.status, ["SENT", "DELIVERED", "READ"])));
}

// ---------------------------------------------------------------------------
// The Inbox is the whole conversation: a template PulseOS sends (a follow-up a person chose, a reminder the engine sent) is
// written into the patient's existing WhatsApp thread, and the provider's delivered/read callbacks keep it up to date.
// ---------------------------------------------------------------------------

const MESSAGE_RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3 };

export const AUTOMATED_SENDER_NAME = "Automated reminder";

/**
 * Show a message PulseOS sent through a provider on the patient's thread. Never creates a conversation or a patient (a patient
 * who has not written in has no thread, and an outbound-only message is not a conversation needing attention); does nothing
 * when the hospital has no Inbox. The provider message id makes a repeat harmless. Returns whether a message was added.
 */
export async function mirrorNotificationToConversation(
  db: Db,
  a: { tenantId: string; patientId: string; connectorId: string; providerMessageId: string; body: string; actorId: string | null; at: Date; deliveryStatus?: "sent" | "delivered" | "read"; templateName?: string | null },
): Promise<boolean> {
  if (!(await tenantCapabilityMap(db, a.tenantId)).WHATSAPP_INBOX) return false;
  const [conversation] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.tenantId, a.tenantId), eq(conversations.connectorId, a.connectorId), eq(conversations.patientId, a.patientId)))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(1);
  if (!conversation) return false;
  const [inserted] = await db
    .insert(messages)
    .values({
      tenantId: a.tenantId,
      conversationId: conversation.id,
      senderType: "staff",
      senderUserId: a.actorId,
      senderName: a.actorId ? null : AUTOMATED_SENDER_NAME,
      // Everything PulseOS sends through here is an approved template.
      kind: "template",
      templateName: a.templateName ?? null,
      body: a.body,
      sentAt: a.at,
      connectorId: a.connectorId,
      providerMessageId: a.providerMessageId,
      deliveryStatus: a.deliveryStatus ?? "sent",
    })
    .onConflictDoNothing()
    .returning({ id: messages.id });
  if (!inserted) return false;
  await db.update(conversations).set({ lastMessageAt: sql`greatest(${conversations.lastMessageAt}, ${a.at.toISOString()}::timestamptz)` }).where(eq(conversations.id, conversation.id));
  await recordConversationActivity(db, a.tenantId, conversation.id, { at: a.at, sender: "staff" });
  return true;
}

/** Carry a provider delivery status onto the conversation message with that provider id: forward only, never back from read. */
async function syncMessageDelivery(db: Db, tenantId: string, providerMessageId: string, status: "sent" | "delivered" | "read" | "failed"): Promise<void> {
  const rows = await db.select({ id: messages.id, deliveryStatus: messages.deliveryStatus }).from(messages).where(and(eq(messages.tenantId, tenantId), eq(messages.providerMessageId, providerMessageId)));
  for (const m of rows) {
    const current = m.deliveryStatus ?? "queued";
    if (status === "failed") {
      if (current === "queued" || current === "sent") await db.update(messages).set({ deliveryStatus: "failed" }).where(eq(messages.id, m.id));
    } else if ((MESSAGE_RANK[status] ?? 0) > (MESSAGE_RANK[current] ?? 0)) {
      await db.update(messages).set({ deliveryStatus: status }).where(eq(messages.id, m.id));
    }
  }
}

/**
 * One-off catch-up for messages sent before the Inbox mirrored them: every accepted notification of a hospital that has no
 * conversation message yet is written onto its patient's existing thread. Safe to run repeatedly.
 */
export async function backfillNotificationMessages(db: Db, tenantId: string): Promise<{ checked: number; added: number }> {
  const rows = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.tenantId, tenantId), inArray(notifications.status, ["SENT", "DELIVERED", "READ"]), sql`${notifications.providerMessageId} is not null`, sql`${notifications.renderedText} is not null`))
    .orderBy(asc(notifications.sentAt));
  let added = 0;
  for (const n of rows) {
    const connector = n.provider ? await getConnectorByTenantAndProvider(db, tenantId, n.provider) : null;
    if (!connector) continue;
    const status = n.status === "READ" ? "read" : n.status === "DELIVERED" ? "delivered" : "sent";
    if (await mirrorNotificationToConversation(db, { tenantId, patientId: n.patientId, connectorId: connector.id, providerMessageId: n.providerMessageId!, body: n.renderedText!, actorId: n.createdBy ?? null, at: n.sentAt ?? n.createdAt, deliveryStatus: status, templateName: n.templateId ? ((await db.select({ p: messageTemplates.providerTemplateName }).from(messageTemplates).where(eq(messageTemplates.id, n.templateId)).limit(1))[0]?.p ?? null) : null })) added++;
  }
  return { checked: rows.length, added };
}

/** Bookkeeping after the provider ACCEPTED a message: retried, and never allowed to turn a delivered message into a resend. */
async function recordAfterSend(db: Db, n: Row, connectorId: string, tenantId: string, now: Date, patch: Partial<typeof notifications.$inferInsert>, templateName: string | null = null): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try {
      await finishAfterSend(db, n.id, patch);
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
  // The thread is a convenience view: it must never turn an accepted send into a failure.
  try {
    if (patch.providerMessageId && patch.renderedText) {
      await mirrorNotificationToConversation(db, { tenantId, patientId: n.patientId, connectorId, providerMessageId: patch.providerMessageId, body: patch.renderedText, actorId: n.subjectType === "FOLLOW_UP" ? (n.createdBy ?? null) : null, at: now, templateName });
    }
  } catch (err) {
    console.error("could not show a sent notification in the conversation", n.id, err);
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

  const [template] = n.templateId ? await db.select().from(messageTemplates).where(eq(messageTemplates.id, n.templateId)).limit(1) : [];
  if (!template || !template.enabled) return (await finish(db, n.id, { status: "BLOCKED", reason: "TEMPLATE_UNAVAILABLE" }), "blocked");
  const appointmentChange = template.purpose === "APPOINTMENT_RESCHEDULED" || template.purpose === "APPOINTMENT_CANCELLED";

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
    if (!appointmentChange && ctx.inactiveReason) return (await finish(db, n.id, { status: "CANCELLED", reason: ctx.inactiveReason }), "cancelled");
    // Messages follow CONFIRMED: a visit that is not (or is no longer) confirmed never gets one, whatever was planned earlier.
    if (!appointmentChange && n.subjectType === "APPOINTMENT" && ctx.status !== "confirmed") return (await finish(db, n.id, { status: "CANCELLED", reason: "NOT_CONFIRMED" }), "cancelled");
    if (!appointmentChange && n.subjectAt && ctx.start && ctx.start.getTime() !== n.subjectAt.getTime()) return (await finish(db, n.id, { status: "CANCELLED", reason: "RESCHEDULED" }), "cancelled");
    if (!appointmentChange && ctx.start && ctx.start.getTime() <= now.getTime()) return (await finish(db, n.id, { status: "CANCELLED", reason: "TRIGGER_ALREADY_PASSED" }), "cancelled");
    // A reminder is never sent late: after downtime or a backlog its moment has gone (retries of one already tried are exempt).
    if (n.attempts <= 1 && now.getTime() - n.scheduledFor.getTime() > LATE_GRACE_MS) return (await finish(db, n.id, { status: "CANCELLED", reason: "TRIGGER_ALREADY_PASSED" }), "cancelled");
    patientPhone = ctx.phone;
    values = ctx.values;
  }
  if (!patientPhone) return (await finish(db, n.id, { status: "BLOCKED", reason: "NO_VALID_PHONE" }), "blocked");

  const choice = await resolveSendProvider(db, tenantId, deps.adapterFor ?? getMessagingAdapter);
  if (!choice.ok) return (await finish(db, n.id, { status: "BLOCKED", reason: choice.reason }), "blocked");
  const { connector, adapter, provider } = choice;
  // A retry stays with the provider the first attempt went to: never a silent switch after a possibly-accepted send.
  if (n.provider && n.provider !== provider) return (await finish(db, n.id, { status: "BLOCKED", reason: "PROVIDER_CHANGED" }), "blocked");

  const rendered = n.renderedText ? { text: n.renderedText, missing: [] as string[] } : renderTemplate(template.body, values);
  if (rendered.missing.length > 0) return (await finish(db, n.id, { status: "BLOCKED", reason: "MISSING_VARIABLES" }), "blocked");

  const config: Record<string, unknown> = { ...((connector.configuration as Record<string, unknown> | null) ?? {}), mode: connector.mode.toLowerCase(), pulseosTenantId: tenantId };
  const secrets = connector.mode === "FIXTURE" ? {} : (await getConnectorSecrets(db, connector.id)) ?? {};
  if (provider === WHATSNEXUS_PROVIDER && (!config.baseUrl || !config.tenantId || !secrets.apiKey)) {
    return (await finish(db, n.id, { status: "BLOCKED", reason: "PROVIDER_NOT_CONFIGURED" }), "blocked");
  }
  // Recorded BEFORE the send so a crash, a retry or a late callback can always be attributed to this provider.
  if (!n.provider) await db.update(notifications).set({ provider }).where(and(eq(notifications.id, n.id), isNull(notifications.provider)));

  let providerMessageId: string;
  try {
    const res = await adapter.sendTemplate(config, secrets, patientPhone, { name: template.providerTemplateName, language: template.language, parameters: templateParameters(template.body, values), idempotencyKey: n.id });
    providerMessageId = res.providerMessageId;
  } catch (err) {
    const raw = redactLogText(err instanceof Error ? err.message : String(err)) ?? "send failed";
    // An ambiguous WhatsNexus outcome stays visibly "unknown" (the reconcile job resolves it from WhatsNexus's own record).
    const message = provider === WHATSNEXUS_PROVIDER && err instanceof AmbiguousSendError ? `OUTCOME_UNKNOWN: ${raw}` : raw;
    await db.insert(connectorEvents).values({ tenantId, connectorId: connector.id, externalEventId: `notification:${n.id}:${n.attempts}`, direction: "outbound", status: "failed", error: message, payload: { type: "notification" } }).onConflictDoNothing();
    // A refused TEMPLATE (paused, wrong language, wrong parameter count …) is about that one template, not the connection:
    // it must not flip the whole provider to ERROR. Credentials, billing and transport failures still do.
    const templateProblem = err instanceof PermanentSendError && err.code.startsWith("TEMPLATE_");
    if (!(err instanceof RetryableSendError) && !templateProblem) await touchConnectorError(db, connector.id, message);
    const delay = RETRY_DELAYS_MS[n.attempts - 1];
    // A message a person chose to send is never retried behind their back (they saw it fail and decide what to do).
    if (err instanceof AmbiguousSendError || err instanceof PermanentSendError || n.subjectType === "FOLLOW_UP" || n.attempts >= MAX_SEND_ATTEMPTS || delay === undefined) {
      await finish(db, n.id, { status: "FAILED", reason: message });
      return "failed";
    }
    await finish(db, n.id, { status: "PENDING", reason: message, scheduledFor: new Date(now.getTime() + delay) });
    return "retry";
  }
  // The provider has the message. Nothing below may route into the retry path.
  await recordAfterSend(db, n, connector.id, tenantId, now, { status: "SENT", providerMessageId, renderedText: rendered.text, sentAt: now, reason: null }, template.providerTemplateName);
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
  await syncMessageDelivery(db, tenantId, providerMessageId, status);
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
// WhatsNexus: authenticated delivery callbacks and reconciliation of ambiguous sends
// ---------------------------------------------------------------------------

export type WhatsNexusStatusResult = "applied" | "unknown_notification" | "provider_mismatch" | "wamid_conflict";

const UNKNOWN_OUTCOME_PREFIX = "OUTCOME_UNKNOWN";

/** WhatsNexus has proven the provider accepted a send whose outcome was unknown: it becomes SENT, with the real wamid. */
async function resolveUnknownAsSent(db: Db, n: Row, wamid: string, at: Date): Promise<void> {
  await db
    .update(notifications)
    .set({ status: "SENT", providerMessageId: wamid, sentAt: n.sentAt ?? at, reason: null })
    .where(and(eq(notifications.id, n.id), eq(notifications.status, "FAILED"), like(notifications.reason, `${UNKNOWN_OUTCOME_PREFIX}%`)));
}

/**
 * Apply an AUTHENTICATED WhatsNexus status. The notification is found by its own id (externalId — never a journey id),
 * scoped to the tenant whose connector secret verified the signature, and must have been handed to WhatsNexus. The wamid
 * is bound on first sight and a different wamid afterwards is refused. Status moves only forward (applyDeliveryStatus).
 * Safe if the callback beats the send's own bookkeeping: the row exists from planning, and finishAfterSend keeps its status.
 */
export async function applyWhatsNexusStatus(db: Db, tenantId: string, e: { notificationId: string; wamid: string; status: "sent" | "delivered" | "read" | "failed"; at: Date }): Promise<WhatsNexusStatusResult> {
  const [n] = await db.select().from(notifications).where(and(eq(notifications.tenantId, tenantId), eq(notifications.id, e.notificationId))).limit(1);
  if (!n) return "unknown_notification";
  if (n.provider !== WHATSNEXUS_PROVIDER) return "provider_mismatch";
  if (n.providerMessageId && n.providerMessageId !== e.wamid) return "wamid_conflict";
  if (!n.providerMessageId) {
    await db.update(notifications).set({ providerMessageId: e.wamid }).where(and(eq(notifications.id, n.id), isNull(notifications.providerMessageId)));
  }
  if (n.status === "FAILED" && n.reason?.startsWith(UNKNOWN_OUTCOME_PREFIX)) {
    if (e.status === "failed") await db.update(notifications).set({ reason: "PROVIDER_REPORTED_FAILURE" }).where(eq(notifications.id, n.id));
    else await resolveUnknownAsSent(db, n, e.wamid, e.at);
  }
  await applyDeliveryStatus(db, tenantId, e.wamid, e.status, e.at);
  return "applied";
}

/**
 * Resolve notifications whose WhatsNexus outcome was ambiguous (timeout, unreadable reply). Read-only toward WhatsNexus:
 * it asks what became of the idempotency key and NEVER sends. Left alone while WhatsNexus itself is unsure.
 */
export async function reconcileWhatsNexusOutcomes(db: Db, now: Date, deps: Pick<SendDeps, "adapterFor"> = {}, limit = 25): Promise<Record<string, number>> {
  const tally: Record<string, number> = { checked: 0, accepted: 0, notSent: 0, pending: 0, errors: 0 };
  const rows = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.provider, WHATSNEXUS_PROVIDER), eq(notifications.status, "FAILED"), like(notifications.reason, `${UNKNOWN_OUTCOME_PREFIX}%`), gte(notifications.createdAt, new Date(now.getTime() - 48 * 3_600_000))))
    .orderBy(asc(notifications.createdAt))
    .limit(limit);
  const adapter = (deps.adapterFor ?? getMessagingAdapter)(WHATSNEXUS_PROVIDER);
  if (!adapter?.lookupSend) return tally;
  for (const n of rows) {
    tally.checked!++;
    try {
      const connector = await getConnectorByTenantAndProvider(db, n.tenantId, WHATSNEXUS_PROVIDER);
      if (!connector || connector.status === "DISABLED") continue;
      const secrets = (await getConnectorSecrets(db, connector.id)) ?? {};
      const config: Record<string, unknown> = { ...((connector.configuration as Record<string, unknown> | null) ?? {}), mode: connector.mode.toLowerCase(), pulseosTenantId: n.tenantId };
      const found = await adapter.lookupSend(config, secrets, n.id);
      if (found.state === "accepted") {
        await resolveUnknownAsSent(db, n, found.providerMessageId, now);
        tally.accepted!++;
      } else if (found.state === "failed" || found.state === "not_found") {
        const why = found.state === "failed" ? found.code : "no record at WhatsNexus";
        await db.update(notifications).set({ reason: `NOT_SENT: ${why}` }).where(and(eq(notifications.id, n.id), eq(notifications.status, "FAILED")));
        tally.notSent!++;
      } else {
        tally.pending!++;
      }
    } catch {
      tally.errors!++;
    }
  }
  return tally;
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

export interface PreviewOptions {
  /**
   * Ask WhatsNexus (read-only) whether the saved template is still approved and still fits, so the sheet can say so before
   * anyone presses Send. Off for the preview that the send itself uses: WhatsNexus decides again at the moment of sending.
   */
  checkProvider?: boolean;
  catalogue?: CatalogueDeps;
}

export async function previewFollowUpMessage(db: Db, tenantId: string, actorId: string, journeyId: string, opts: PreviewOptions = {}): Promise<Result<{ preview: WhatsAppPreview }>> {
  const caps = await tenantCapabilityMap(db, tenantId);
  if (!caps.WHATSAPP_NOTIFICATIONS) return { ok: false, reason: "feature_not_available" };
  await ensureNotificationDefaults(db, tenantId);
  const ctx = await manualContext(db, tenantId, journeyId, actorId);
  if (!ctx) return { ok: false, reason: "journey_not_found" };
  const [template] = await db.select().from(messageTemplates).where(and(eq(messageTemplates.tenantId, tenantId), eq(messageTemplates.purpose, "FOLLOW_UP_MESSAGE"))).limit(1);
  if (!template) return { ok: false, reason: "template_not_found" };
  const rendered = renderTemplate(template.body, ctx.values);
  const choice = await resolveSendProvider(db, tenantId);
  let blockedReason = !template.enabled ? "TEMPLATE_UNAVAILABLE" : !ctx.phone ? "NO_VALID_PHONE" : !choice.ok ? "PROVIDER_NOT_CONFIGURED" : rendered.missing.length ? "MISSING_VARIABLES" : null;

  const delivery: WhatsAppDelivery = {
    provider: choice.ok ? (choice.provider === WHATSNEXUS_PROVIDER ? "whatsnexus" : "meta") : null,
    templateName: template.providerTemplateName,
    language: template.language,
    category: null,
    parameters: variablesUsed(template.body).map((variable, i) => ({ position: i + 1, variable, value: (ctx.values as Record<string, string>)[variable] ?? "" })),
  };
  // WhatsNexus is the authority on approval; its answer is read now, never remembered. If it cannot be asked, the send is
  // not blocked here — WhatsNexus checks again when the message is actually sent.
  if (opts.checkProvider && choice.ok && choice.provider === WHATSNEXUS_PROVIDER) {
    const catalogue = await fetchProviderTemplateCatalogue(db, tenantId, opts.catalogue);
    if (catalogue.state === "OK") {
      delivery.category = catalogue.templates.find((t) => t.name === template.providerTemplateName && t.language.toLowerCase() === template.language.toLowerCase())?.category ?? null;
      const check = checkProviderTemplate({ providerTemplateName: template.providerTemplateName, language: template.language, variableCount: delivery.parameters.length }, catalogue.templates);
      if (!check.ok && !blockedReason) blockedReason = check.code;
    }
  }
  return { ok: true, preview: { recipient: ctx.phone ? maskPhone(ctx.phone) : "No valid number", text: rendered.text, templateName: template.name, missingVariables: rendered.missing, canSend: blockedReason === null, blockedReason, delivery } };
}

/**
 * A person chose to send this message. It goes through the same durable path as every other notification (one row, the same
 * adapter, the same status tracking), is recorded on the Journey timeline, and never completes the follow-up task.
 */
export async function sendFollowUpMessage(db: Db, tenantId: string, actorId: string, journeyId: string, idempotencyKey: string, deps: SendDeps = {}, now: Date = new Date()): Promise<Result<{ notificationId: string; status: string; duplicate: boolean; /** Why it failed or was blocked (provider code and message), so staff see the real reason. */ reason: string | null }>> {
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
    return { ok: true, notificationId: existing!.id, status: existing!.status, duplicate: true, reason: existing!.reason };
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
  return { ok: true, notificationId: inserted.id, status: after!.status, duplicate: false, reason: after!.reason };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listNotificationsFor(db: Db, tenantId: string, type: string, id: string): Promise<NotificationVm[]> {
  const rows = await db.select({ n: notifications, purpose: messageTemplates.purpose }).from(notifications).leftJoin(messageTemplates, eq(messageTemplates.id, notifications.templateId))
    .where(and(eq(notifications.tenantId, tenantId), eq(notifications.subjectType, type), eq(notifications.subjectId, id))).orderBy(desc(notifications.scheduledFor));
  return rows.map(({ n, purpose }) => ({ id: n.id, subject: n.subjectType as NotificationVm["subject"], subjectId: n.subjectId, status: n.status as NotificationVm["status"], reason: n.reason, scheduledFor: n.scheduledFor.toISOString(), sentAt: n.sentAt?.toISOString() ?? null, templatePurpose: (purpose as TemplatePurpose | null) ?? null }));
}
