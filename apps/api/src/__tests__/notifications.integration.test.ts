import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppointmentRow, MessageTemplateVm, NotificationRuleVm, Role, TreatmentDefinitionVm, WhatsAppPreview } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { appointments, notifications, scheduleResources, tasks, timelineEvents } from "../db/schema.js";
import { getMessagingAdapter } from "../domain/connector/registry.js";
import { applyDeliveryStatus, planForSubject, processDueNotifications } from "../domain/notification/notification.service.js";
import { AmbiguousSendError, type MessagingProviderAdapter } from "../domain/connector/types.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe.skipIf(!DEMO_PASSWORD)("notifications: reminders and staff WhatsApp (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant; // V1: notifications on, inbox off
  let bare: TestTenant; // V1 with no WhatsApp connector at all
  let other: TestTenant;
  let resourceId: string;
  const resourceOf = new Map<string, string>();
  let cataract: TreatmentDefinitionVm;
  let n = 0;
  let slot = 0;

  const call = (tt: TestTenant, role: Role, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object) => app.inject({ method, url, cookies: { pulseos_session: tt.cookie[role]! }, ...(payload ? { payload } : {}) });
  const phone = () => `+9196${String(61000000 + ++n * 31).padStart(8, "0")}`;
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000 + ++slot * 60_000);

  async function journey(tt: TestTenant = t) {
    const res = await call(tt, "FRONT_DESK", "POST", "/leads", { phone: phone(), name: "Asha Rao", specialtyKey: "CATARACT", branchId: tt.branchId, journeyType: "Cataract", sourceKey: "google", customFieldValues: {} });
    expect(res.statusCode).toBe(201);
    return res.json() as { patientId: string; journeyId: string };
  }
  const confirm = async (id: string, tt: TestTenant = t) => expect((await call(tt, "FRONT_DESK", "PATCH", `/appointments/${id}/action`, { action: "confirm" })).statusCode).toBe(200);
  /** Books the visit and, by default, confirms it: the confirmation message and the reminders follow CONFIRMED, not booked. */
  async function book(hours: number, tt: TestTenant = t, doctorId = resourceOf.get(tt.tenantId)!, confirmIt = true) {
    const { patientId, journeyId } = await journey(tt);
    const res = await call(tt, "FRONT_DESK", "POST", "/appointments", { patientId, journeyId, branchId: tt.branchId, doctorId, scheduledAt: inHours(hours).toISOString(), reason: "Consultation" });
    expect(res.statusCode).toBe(201);
    const booked = res.json() as AppointmentRow;
    if (confirmIt) await confirm(booked.id, tt);
    return { ...booked, patientId, journeyId };
  }
  const rows = (subjectId: string) => db.select().from(notifications).where(eq(notifications.subjectId, subjectId));
  /** Domain events are published after commit and consumed asynchronously: wait for the consumer to finish. */
  async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 4000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (ok(v) || Date.now() > end) return v;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const planned = (subjectId: string, count: number) => until(() => rows(subjectId), (r) => r.length >= count);
  /** The shared dev DB may hold other tenants' due rows: whatever the worker touches here must be a fixture, never a live provider. */
  const fixtureOnly = {
    adapterFor: (provider: string) => {
      const real = getMessagingAdapter(provider)!;
      return { ...real, sendTemplate: async (cfg: Record<string, unknown>, sec: Record<string, unknown>, to: string, tpl: { name: string; language: string; parameters: string[] }) => { if (cfg.mode !== "fixture") throw new Error("test guard: refusing a non-fixture send"); return real.sendTemplate(cfg, sec, to, tpl); } };
    },
  };
  const sorted = <T extends { scheduledFor: Date }>(xs: T[]) => [...xs].sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime());

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    bare = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    other = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    for (const tt of [t, bare, other]) await call(tt, "HOSPITAL_ADMIN", "POST", "/departments/install", { templateKey: "ophthalmology" });
    cataract = ((await call(t, "HOSPITAL_ADMIN", "GET", "/treatment-catalog")).json() as TreatmentDefinitionVm[]).find((d) => d.key === "CATARACT_SURGERY")!;
    for (const tt of [t, bare, other]) resourceOf.set(tt.tenantId, (await db.select({ id: scheduleResources.id }).from(scheduleResources).where(eq(scheduleResources.linkedUserId, tt.userIds.DOCTOR!)))[0]!.id);
    resourceId = resourceOf.get(t.tenantId)!;
    // A fixture WhatsApp connection for `t` only (no credentials needed: a fixture never contacts the provider).
    expect((await call(t, "HOSPITAL_ADMIN", "PUT", "/integrations/hub/whatsapp_meta_cloud/configuration", { configuration: { phoneNumberId: "pn-test" } })).statusCode).toBe(200);
  });
  afterAll(async () => {
    for (const tt of [t, bare, other]) {
      await db.delete(tasks).where(eq(tasks.tenantId, tt.tenantId));
      await db.execute(`delete from treatment_opportunities where tenant_id = '${tt.tenantId}'` as never).catch(() => {});
      await db.delete(appointments).where(eq(appointments.tenantId, tt.tenantId));
      await destroyTestTenant(db, tt);
    }
    await app.close();
    await queryClient.end();
  });

  it("WhatsApp Notifications work with the Inbox off: the notification API answers while the Inbox API is refused", async () => {
    expect((await call(t, "HOSPITAL_ADMIN", "GET", "/notifications/rules")).statusCode).toBe(200);
    const inbox = await call(t, "FRONT_DESK", "GET", "/conversations");
    expect(inbox.statusCode).toBe(403);
    expect(inbox.json().error).toBe("feature_not_available");
  });

  it("default rules and templates exist: confirmation now, reminders 1 day and 1 hour before", async () => {
    const rules = (await call(t, "HOSPITAL_ADMIN", "GET", "/notifications/rules")).json() as NotificationRuleVm[];
    expect(rules.filter((r) => r.subject === "APPOINTMENT").map((r) => `${r.kind}:${r.offsetValue}${r.offsetUnit}`)).toEqual(["CONFIRMATION:0minutes", "REMINDER:1days", "REMINDER:1hours"]);
    expect(rules.filter((r) => r.subject === "SURGERY").map((r) => `${r.offsetValue}${r.offsetUnit}`).sort()).toEqual(["1days", "1hours", "2hours"]);
    expect(rules.every((r) => r.minGapMinutes === 60 && r.channel === "WHATSAPP" && r.templateId)).toBe(true);
    const templates = (await call(t, "HOSPITAL_ADMIN", "GET", "/notifications/templates")).json() as MessageTemplateVm[];
    expect(templates.map((x) => x.purpose).sort()).toEqual(["APPOINTMENT_CONFIRMATION", "APPOINTMENT_REMINDER", "FOLLOW_UP_MESSAGE", "SURGERY_REMINDER"]);
  });

  it("booked is not confirmed: nothing is planned until the visit is confirmed; confirming plans exactly one confirmation + the reminders; confirming again adds nothing", async () => {
    const a = await book(72, t, resourceOf.get(t.tenantId)!, false);
    await new Promise((r) => setTimeout(r, 400));
    expect(await rows(a.id)).toHaveLength(0);
    // The guard itself, not just the absence of rows after a sleep:
    expect(await planForSubject(db, t.tenantId, "APPOINTMENT", a.id)).toEqual({ planned: 0, suppressed: ["NOT_CONFIRMED"] });
    await confirm(a.id);
    const rs = await planned(a.id, 3);
    expect(rs.filter((r) => r.scheduledFor.getTime() < Date.now() + 10_000)).toHaveLength(1);
    await confirm(a.id); // a repeat click: the visit is already confirmed
    expect((await planForSubject(db, t.tenantId, "APPOINTMENT", a.id)).planned).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(await rows(a.id)).toHaveLength(3);
  });

  it("booking creates the confirmation (now) and both reminders; a repeat plan adds nothing (idempotent)", async () => {
    const a = await book(72);
    const rs = sorted(await planned(a.id, 3));
    expect(rs).toHaveLength(3);
    expect(rs.every((r) => r.status === "PENDING" && r.subjectType === "APPOINTMENT")).toBe(true);
    const start = new Date(a.scheduledAt).getTime();
    expect(rs[1]!.scheduledFor.getTime()).toBe(start - 86_400_000);
    expect(rs[2]!.scheduledFor.getTime()).toBe(start - 3_600_000);
    expect(Date.now() - rs[0]!.scheduledFor.getTime()).toBeLessThan(10_000);
    expect((await planForSubject(db, t.tenantId, "APPOINTMENT", a.id)).planned).toBe(0);
    expect(await rows(a.id)).toHaveLength(3);
  });

  it("late bookings are never reminded late: 3 hours ahead → no 1-day reminder; 30 minutes ahead → confirmation only", async () => {
    const soon = await book(3);
    const soonRows = await planned(soon.id, 2);
    expect(soonRows).toHaveLength(2);
    const verySoon = await book(0.5);
    await planned(verySoon.id, 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(await rows(verySoon.id)).toHaveLength(1);
  });

  it("the worker sends what is due once (confirmation), leaves the future alone, and never resends", async () => {
    const a = await book(72);
    await planned(a.id, 3);
    const first = await processDueNotifications(db, new Date(), fixtureOnly);
    expect(first.sent).toBeGreaterThanOrEqual(1);
    const after = sorted(await rows(a.id));
    expect(after[0]).toMatchObject({ status: "SENT" });
    expect(after[0]!.providerMessageId).toMatch(/^FIXTURE_WAMID_pn-test_/); // fixture: nothing real was contacted
    expect(after[0]!.renderedText).toContain("Hello Asha Rao");
    expect(after[0]!.renderedText).toContain("with doctor "); // the doctor resource of the test tenant
    expect(after[1]!.status).toBe("PENDING");
    const second = await processDueNotifications(db, new Date(), fixtureOnly);
    expect(second.sent).toBe(0);
    expect((await rows(a.id)).filter((r) => r.status === "SENT")).toHaveLength(1);
  });

  it("reschedule: pending reminders for the old time are cancelled, new ones follow the new time; what was already sent stays", async () => {
    const a = await book(72);
    await planned(a.id, 3);
    await processDueNotifications(db, new Date(), fixtureOnly); // confirmation goes out
    const newAt = inHours(120);
    expect((await call(t, "FRONT_DESK", "PATCH", `/appointments/${a.id}/reschedule`, { scheduledAt: newAt.toISOString(), reasonCode: "patient_requested" })).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(await rows(a.id)).toHaveLength(3); // moved visits are booked again, not confirmed: nothing new until re-confirmed
    await confirm(a.id);
    const all = await until(() => rows(a.id), (r) => r.length >= 6);
    expect(all.filter((r) => r.status === "CANCELLED" && r.reason === "RESCHEDULED")).toHaveLength(2); // the old day/hour reminders
    expect(all.filter((r) => r.status === "SENT")).toHaveLength(1);
    const fresh = all.filter((r) => r.subjectAt!.getTime() === newAt.getTime() && r.status === "PENDING");
    expect(fresh).toHaveLength(3); // a new confirmation (now) and the two reminders at the new time
    expect(sorted(fresh).map((r) => r.scheduledFor.getTime()).slice(1)).toEqual([newAt.getTime() - 86_400_000, newAt.getTime() - 3_600_000]);
  });

  it("cancel and no-show stop the pending reminders", async () => {
    const a = await book(72);
    await planned(a.id, 3);
    expect((await call(t, "FRONT_DESK", "PATCH", `/appointments/${a.id}/action`, { action: "cancel", reasonCode: "patient_requested" })).statusCode).toBe(200);
    const after = await until(() => rows(a.id), (r) => r.every((x) => x.status !== "PENDING"));
    expect(after.length).toBe(3);
    expect(after.every((r) => r.status === "CANCELLED" && r.reason === "APPOINTMENT_CANCELLED")).toBe(true);
    await processDueNotifications(db, new Date(Date.now() + 80 * 3_600_000), fixtureOnly);
    expect((await rows(a.id)).some((r) => r.status === "SENT")).toBe(false);
  });

  it("the worker re-checks the visit before sending: moved or cancelled behind the engine's back → never sent", async () => {
    const moved = await book(72);
    const cancelled = await book(72);
    await planned(moved.id, 3);
    await planned(cancelled.id, 3);
    await db.update(appointments).set({ scheduledAt: inHours(200) }).where(eq(appointments.id, moved.id)); // no event published
    await db.update(appointments).set({ status: "cancelled" }).where(eq(appointments.id, cancelled.id));
    await processDueNotifications(db, new Date(Date.now() + 71.5 * 3_600_000), fixtureOnly); // every reminder is now due
    const movedRows = await rows(moved.id);
    expect(movedRows.length).toBe(3);
    expect(movedRows.every((r) => r.status === "CANCELLED" && r.reason === "RESCHEDULED")).toBe(true);
    expect((await rows(cancelled.id)).filter((r) => r.status === "SENT")).toHaveLength(0);
    expect((await rows(cancelled.id))[0]!.reason).toBe("APPOINTMENT_CANCELLED");
  });

  it("the worker never sends for a visit that is not confirmed (e.g. planned earlier, then demoted behind the engine's back)", async () => {
    const a = await book(72);
    await planned(a.id, 3);
    await db.update(appointments).set({ status: "scheduled" }).where(eq(appointments.id, a.id)); // no event published
    await processDueNotifications(db, new Date(Date.now() + 71.5 * 3_600_000), fixtureOnly);
    const after = await rows(a.id);
    expect(after.filter((r) => r.status === "SENT")).toHaveLength(0);
    expect(after.every((r) => r.status === "CANCELLED" && r.reason === "NOT_CONFIRMED")).toBe(true);
  });

  it("provider not configured → BLOCKED with the reason, not silently dropped; capability off → nothing is planned", async () => {
    const b = await book(72, bare);
    await planned(b.id, 3);
    await processDueNotifications(db, new Date(), fixtureOnly);
    const blocked = (await rows(b.id)).filter((r) => r.status === "BLOCKED");
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    expect(blocked[0]!.reason).toBe("PROVIDER_NOT_CONFIGURED");

    expect((await call(bare, "HOSPITAL_ADMIN", "PUT", "/capabilities/WHATSAPP_NOTIFICATIONS", { enabled: false })).statusCode).toBe(200);
    const c = await book(72, bare);
    await new Promise((r) => setTimeout(r, 400));
    expect(await rows(c.id)).toHaveLength(0);
    expect((await call(bare, "HOSPITAL_ADMIN", "GET", "/notifications/rules")).statusCode).toBe(403);
  });

  it("a switched-off capability blocks what was already queued", async () => {
    const a = await book(72, other);
    await planned(a.id, 3);
    expect((await call(other, "HOSPITAL_ADMIN", "PUT", "/capabilities/WHATSAPP_NOTIFICATIONS", { enabled: false })).statusCode).toBe(200);
    await processDueNotifications(db, new Date(), fixtureOnly);
    const blocked = (await rows(a.id)).filter((r) => r.status === "BLOCKED");
    expect(blocked.length).toBeGreaterThanOrEqual(1); // the confirmation was due: it must have been blocked, not silently skipped
    expect(blocked.every((r) => r.reason === "CAPABILITY_DISABLED")).toBe(true);
    expect((await rows(a.id)).some((r) => r.status === "SENT")).toBe(false);
  });

  it("a reminder rule switched off stops what it already queued: cancelled with the reason, never sent", async () => {
    const rules = (await call(t, "HOSPITAL_ADMIN", "GET", "/notifications/rules")).json() as NotificationRuleVm[];
    const confirmation = rules.find((r) => r.subject === "APPOINTMENT" && r.kind === "CONFIRMATION")!;
    const a = await book(72);
    await planned(a.id, 3);
    try {
      expect((await call(t, "HOSPITAL_ADMIN", "PATCH", `/notifications/rules/${confirmation.id}`, { enabled: false })).statusCode).toBe(200);
      await processDueNotifications(db, new Date(), fixtureOnly);
      const after = sorted(await rows(a.id));
      expect(after[0]).toMatchObject({ status: "CANCELLED", reason: "RULE_DISABLED" }); // the confirmation was due now
      expect(after.some((r) => r.status === "SENT")).toBe(false);
      expect(after.slice(1).every((r) => r.status === "PENDING")).toBe(true); // the other rules still apply
    } finally {
      await call(t, "HOSPITAL_ADMIN", "PATCH", `/notifications/rules/${confirmation.id}`, { enabled: true });
    }
  });

  it("provider failures retry with backoff, then fail; the stored error never carries a credential", async () => {
    const a = await book(72);
    await planned(a.id, 3);
    const failing: MessagingProviderAdapter = {
      capabilities: [], verifyWebhookChallenge: () => null, verifyWebhookSignature: () => false, parseWebhookPayload: () => ({ messages: [], statuses: [] }),
      sendMessage: async () => { throw new Error("no"); },
      sendTemplate: async () => { throw new Error("upstream said access_token=EAAB1234567890123456789012345 Bearer abc.def.ghi"); },
    };
    const deps = { adapterFor: () => failing };
    const first = await processDueNotifications(db, new Date(), deps);
    expect(first.retry).toBeGreaterThanOrEqual(1);
    const [r1] = sorted(await rows(a.id));
    expect(r1).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(r1!.reason).toContain("[redacted]");
    expect(JSON.stringify(r1)).not.toContain("EAAB1234567890");
    expect(JSON.stringify(r1)).not.toContain("abc.def.ghi");
    let at = Date.now();
    for (let i = 0; i < 3; i++) { at += 3_600_000; await processDueNotifications(db, new Date(at), deps); }
    const [fin] = sorted(await rows(a.id));
    expect(fin).toMatchObject({ status: "FAILED", attempts: 3 });
  });

  it("an ambiguous provider outcome (timeout after sending) is never retried; a send interrupted mid-flight is failed, never re-sent", async () => {
    const a = await book(72);
    await planned(a.id, 3);
    const calls: string[] = [];
    const ambiguous: MessagingProviderAdapter = {
      capabilities: [], verifyWebhookChallenge: () => null, verifyWebhookSignature: () => false, parseWebhookPayload: () => ({ messages: [], statuses: [] }),
      sendMessage: async () => { throw new Error("no"); },
      sendTemplate: async () => { calls.push("send"); throw new AmbiguousSendError("timed out; delivery unknown"); },
    };
    await processDueNotifications(db, new Date(), { adapterFor: () => ambiguous });
    const first = sorted(await rows(a.id))[0]!;
    expect(first.status).toBe("FAILED");
    await processDueNotifications(db, new Date(Date.now() + 3_600_000), { adapterFor: () => ambiguous });
    expect(calls.length).toBe(1);
    // A row stuck PROCESSING (worker died after the provider call) is failed after the grace period, not handed back to PENDING.
    const b = await book(96);
    await planned(b.id, 3);
    const [row] = sorted(await rows(b.id));
    await db.update(notifications).set({ status: "PROCESSING", processingStartedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(notifications.id, row!.id));
    await processDueNotifications(db, new Date(), fixtureOnly);
    const after = (await rows(b.id)).find((r) => r.id === row!.id)!;
    expect(after).toMatchObject({ status: "FAILED", reason: "SEND_INTERRUPTED" });
  });

  it("delivery status only moves forward: sent → delivered → read, and a late 'delivered' never regresses a read", async () => {
    const a = await book(72);
    await planned(a.id, 3);
    await processDueNotifications(db, new Date(), fixtureOnly);
    const [sent] = sorted(await rows(a.id));
    const id = sent!.providerMessageId!;
    expect(await applyDeliveryStatus(db, t.tenantId, id, "delivered", new Date())).toBe(true);
    expect((await rows(a.id)).find((r) => r.providerMessageId === id)!.status).toBe("DELIVERED");
    await applyDeliveryStatus(db, t.tenantId, id, "read", new Date());
    await applyDeliveryStatus(db, t.tenantId, id, "delivered", new Date());
    await applyDeliveryStatus(db, t.tenantId, id, "failed", new Date());
    const final = (await rows(a.id)).find((r) => r.providerMessageId === id)!;
    expect(final.status).toBe("READ");
    expect(final.readAt).toBeTruthy();
    expect(await applyDeliveryStatus(db, t.tenantId, "unknown-id", "read", new Date())).toBe(false);
  });

  it("surgery reminders: 1 day, 2 hours, 1 hour before; cancelling the surgery stops them", async () => {
    const { journeyId } = await journey();
    const when = inHours(96);
    const res = await call(t, "PATIENT_COORDINATOR", "POST", `/journeys/${journeyId}/surgery`, { treatmentDefinitionId: cataract.id, scheduledAt: when.toISOString(), resourceId, branchId: t.branchId });
    expect(res.statusCode).toBe(201);
    const { treatmentId } = res.json() as { treatmentId: string };
    const rs = sorted(await planned(treatmentId, 3));
    expect(rs.map((r) => when.getTime() - r.scheduledFor.getTime())).toEqual([86_400_000, 7_200_000, 3_600_000]);
    expect(rs.every((r) => r.subjectType === "SURGERY")).toBe(true);
    expect((await call(t, "PATIENT_COORDINATOR", "PATCH", `/treatments/${treatmentId}/status`, { status: "CANCELLED" })).statusCode).toBeLessThan(300);
    const after = await until(() => rows(treatmentId), (r) => r.every((x) => x.status !== "PENDING"));
    expect(after.every((r) => r.status === "CANCELLED")).toBe(true);
  });

  it("templates: only declared variables; Admin edits, Staff cannot; rules validate", async () => {
    const templates = (await call(t, "HOSPITAL_ADMIN", "GET", "/notifications/templates")).json() as MessageTemplateVm[];
    const reminder = templates.find((x) => x.purpose === "APPOINTMENT_REMINDER")!;
    expect((await call(t, "HOSPITAL_ADMIN", "PATCH", `/notifications/templates/${reminder.id}`, { body: "Hi {{patient_name}}, see you {{diagnosis}}" })).statusCode).toBe(422);
    expect((await call(t, "FRONT_DESK", "PATCH", `/notifications/templates/${reminder.id}`, { body: "Hi {{patient_name}}" })).statusCode).toBe(403);
    expect((await call(t, "HOSPITAL_ADMIN", "PATCH", `/notifications/templates/${reminder.id}`, { body: "Hi {{patient_name}}, see you on {{date}} at {{time}}." })).statusCode).toBe(200);
    const rules = (await call(t, "HOSPITAL_ADMIN", "GET", "/notifications/rules")).json() as NotificationRuleVm[];
    const confirmation = rules.find((r) => r.kind === "CONFIRMATION")!;
    const dayRule = rules.find((r) => r.subject === "APPOINTMENT" && r.offsetUnit === "days")!;
    expect((await call(t, "HOSPITAL_ADMIN", "PATCH", `/notifications/rules/${confirmation.id}`, { offsetValue: 5 })).statusCode).toBe(422);
    expect((await call(t, "HOSPITAL_ADMIN", "PATCH", `/notifications/rules/${dayRule.id}`, { offsetValue: 0 })).statusCode).toBe(422);
    expect((await call(t, "HOSPITAL_ADMIN", "PATCH", `/notifications/rules/${dayRule.id}`, { templateId: templates.find((x) => x.purpose === "SURGERY_REMINDER")!.id })).statusCode).toBe(422);
    const ok = await call(t, "HOSPITAL_ADMIN", "PATCH", `/notifications/rules/${dayRule.id}`, { offsetValue: 2, offsetUnit: "days", minGapMinutes: 30 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ offsetValue: 2, offsetUnit: "days", minGapMinutes: 30 });
    await call(t, "HOSPITAL_ADMIN", "PATCH", `/notifications/rules/${dayRule.id}`, { offsetValue: 1, offsetUnit: "days", minGapMinutes: 60 });
  });

  it("staff send a WhatsApp message from a follow-up: preview first, send once, timeline updated, the task is NOT completed", async () => {
    const { journeyId, patientId } = await journey();
    const task = await call(t, "FRONT_DESK", "POST", "/tasks", { patientId, journeyId, type: "CALLBACK", dueAt: inHours(2).toISOString(), reason: "manual_task" });
    const taskId = (task.json() as { task?: { id: string }; id?: string }).task?.id ?? (task.json() as { id: string }).id;

    const preview = (await call(t, "FRONT_DESK", "GET", `/journeys/${journeyId}/whatsapp/preview`)).json() as WhatsAppPreview;
    expect(preview).toMatchObject({ canSend: true, blockedReason: null, missingVariables: [] });
    expect(preview.text).toContain("Hello Asha Rao");
    expect(preview.recipient).toContain("•"); // masked, never the full number
    expect(preview.recipient).not.toContain("96");

    const key = `k-${Date.now()}-abcdef`;
    const sent = await call(t, "FRONT_DESK", "POST", `/journeys/${journeyId}/whatsapp`, { idempotencyKey: key });
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toMatchObject({ status: "SENT", duplicate: false });
    const again = await call(t, "FRONT_DESK", "POST", `/journeys/${journeyId}/whatsapp`, { idempotencyKey: key });
    expect(again.json()).toMatchObject({ duplicate: true });
    expect(await db.select().from(notifications).where(and(eq(notifications.journeyId, journeyId), eq(notifications.subjectType, "FOLLOW_UP")))).toHaveLength(1);

    const line = await db.select().from(timelineEvents).where(and(eq(timelineEvents.journeyId, journeyId), eq(timelineEvents.eventType, "whatsapp_sent")));
    expect(line).toHaveLength(1);
    if (taskId) expect((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.status).not.toBe("completed");
  });

  it("staff send is blocked with a reason when it cannot work, refused when the capability is off, and tenant scoped", async () => {
    const { journeyId } = await journey(bare);
    expect((await call(bare, "FRONT_DESK", "GET", `/journeys/${journeyId}/whatsapp/preview`)).statusCode).toBe(403); // capability switched off above
    const mine = await journey();
    // Switch `other` back on first, so the 404 below is the TENANT check, not the capability gate answering early.
    expect((await call(other, "HOSPITAL_ADMIN", "PUT", "/capabilities/WHATSAPP_NOTIFICATIONS", { enabled: null })).statusCode).toBe(200);
    expect((await call(other, "FRONT_DESK", "GET", `/journeys/${mine.journeyId}/whatsapp/preview`)).statusCode).toBe(404);
    expect((await call(other, "FRONT_DESK", "POST", `/journeys/${mine.journeyId}/whatsapp`, { idempotencyKey: `x-${Date.now()}-abcdefgh` })).statusCode).toBe(404);
    expect((await call(t, "FRONT_DESK", "GET", `/journeys/00000000-0000-0000-0000-000000000000/whatsapp/preview`)).statusCode).toBe(404);
    const unconfigured = await journey(t);
    const key = `k-${Date.now()}-zzzzzz`;
    expect((await call(t, "DOCTOR", "POST", `/journeys/${unconfigured.journeyId}/whatsapp`, { idempotencyKey: key })).statusCode).toBe(403); // a Doctor may not send follow-up messages
  });
});
