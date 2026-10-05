import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { LeadsWorkspace, Role } from "@pulseos/types";
import { LEAD_VIEWS } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { appointments, journeys, tasks } from "../db/schema.js";
import { zonedWallTime } from "../lib/hospital-time.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const IST = "Asia/Kolkata";
const dayIST = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString("en-CA", { timeZone: IST });
const at = (offsetDays: number, hh: number, mm = 0) => zonedWallTime(dayIST(offsetDays), hh, mm, IST);

describe.skipIf(!DEMO_PASSWORD)("Leads workspace (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  let other: TestTenant;
  let n = 0;
  const ids: Record<string, { journeyId: string; patientId: string }> = {};
  const as = (tt: TestTenant, role: Role) => ({ pulseos_session: tt.cookie[role]! });
  const ws = async (qs = "", tt: TestTenant = t, role: Role = "PATIENT_COORDINATOR") => {
    const res = await app.inject({ method: "GET", url: `/leads/workspace${qs ? `?${qs}` : ""}`, cookies: as(tt, role) });
    return { status: res.statusCode, body: res.json() as LeadsWorkspace };
  };
  const rowNames = (w: LeadsWorkspace) => w.rows.map((r) => r.patientName).sort();

  async function lead(name: string, extra: { source?: string; journeyType?: string } = {}) {
    const res = await app.inject({
      method: "POST", url: "/leads", cookies: as(t, "PATIENT_COORDINATOR"),
      payload: { name, phone: `+9198${String(70000000 + ++n * 41).padStart(8, "0")}`, specialtyKey: "CATARACT", branchId: t.branchId, sourceKey: extra.source ?? "google", journeyType: extra.journeyType ?? "Cataract" },
    });
    expect(res.statusCode, res.body).toBe(201);
    const out = res.json() as { journeyId: string; patientId: string };
    ids[name] = out;
    return out;
  }
  const backdate = (journeyId: string, days: number, set: Partial<typeof journeys.$inferInsert> = {}) =>
    db.update(journeys).set({ createdAt: at(-days, 11), ...set }).where(eq(journeys.id, journeyId));
  const task = (name: string, dueAt: Date) =>
    db.insert(tasks).values({ tenantId: t.tenantId, patientId: ids[name]!.patientId, journeyId: ids[name]!.journeyId, assignedTo: t.userIds.PATIENT_COORDINATOR!, type: "CALLBACK", dueAt, status: "pending" });
  const visit = (name: string, scheduledAt: Date, status: "scheduled" | "cancelled" = "scheduled") =>
    db.insert(appointments).values({ tenantId: t.tenantId, patientId: ids[name]!.patientId, journeyId: ids[name]!.journeyId, branchId: t.branchId, doctorUserId: t.userIds.DOCTOR!, scheduledAt, status });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    other = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);

    await lead("Newt Today", { source: "instagram" });
    await lead("Overdue Olive");
    await lead("Booked Today Bina");
    await lead("Booked Later Lata");
    await lead("Old Uncontacted Uma", { source: "walk_in", journeyType: "LASIK" });
    await lead("Lost Lalit");
    await lead("Tomorrow Tara");
    await lead("Cancelled Chitra");

    const coordinator = t.userIds.PATIENT_COORDINATOR!;
    await backdate(ids["Overdue Olive"]!.journeyId, 10, { stage: "contacted", contactedAt: at(-9, 10), ownerUserId: coordinator });
    await task("Overdue Olive", at(-1, 12)); // yesterday noon: past due whenever the suite runs
    await backdate(ids["Booked Today Bina"]!.journeyId, 3, { stage: "booked", contactedAt: at(-2, 10) });
    await visit("Booked Today Bina", at(0, 23, 30));
    await backdate(ids["Booked Later Lata"]!.journeyId, 3, { stage: "booked", contactedAt: at(-2, 10) });
    await visit("Booked Later Lata", at(5, 11));
    await backdate(ids["Old Uncontacted Uma"]!.journeyId, 40);
    await backdate(ids["Lost Lalit"]!.journeyId, 6, { stage: "lost", contactedAt: at(-5, 10) });
    await task("Lost Lalit", at(-1, 12)); // a lost lead never needs attention, even with an open task
    await backdate(ids["Tomorrow Tara"]!.journeyId, 2, { stage: "contacted", contactedAt: at(-1, 10) });
    await task("Tomorrow Tara", at(1, 11));
    await backdate(ids["Cancelled Chitra"]!.journeyId, 2);
    await visit("Cancelled Chitra", at(0, 14), "cancelled");

    // Another hospital with its own enquiry: must never show up here.
    await app.inject({ method: "POST", url: "/leads", cookies: as(other, "PATIENT_COORDINATOR"), payload: { name: "Foreign Fiona", phone: "+919800000001", specialtyKey: "CATARACT", branchId: other.branchId, sourceKey: "google", journeyType: "Cataract" } });
  });

  afterAll(async () => {
    await destroyTestTenant(db, t);
    await destroyTestTenant(db, other);
    await app.close();
    await queryClient.end();
  });

  it("is for people who manage leads: Doctor is forbidden, anonymous is 401", async () => {
    expect((await ws("", t, "DOCTOR")).status).toBe(403);
    expect((await app.inject({ method: "GET", url: "/leads/workspace" })).statusCode).toBe(401);
  });

  it("All lists this hospital's leads only, with the enquiry, outcome, next action and visit fields the table needs", async () => {
    const { status, body } = await ws();
    expect(status).toBe(200);
    expect(rowNames(body)).toHaveLength(8);
    expect(rowNames(body)).not.toContain("Foreign Fiona");
    const olive = body.rows.find((r) => r.patientName === "Overdue Olive")!;
    expect(olive.journeyType).toBe("Cataract");
    expect(olive.nextAction).toMatchObject({ label: "Callback", overdue: true });
    const bina = body.rows.find((r) => r.patientName === "Booked Today Bina")!;
    expect(bina.nextAppointment).toMatchObject({ status: "scheduled" });
    expect(body.rows.find((r) => r.patientName === "Cancelled Chitra")!.nextAppointment).toBeNull();
    expect(body.period.timezone).toBe(IST);
    expect(body.period.today).toBe(dayIST(0));
    // Filter options are what occurs in THIS hospital, not the whole catalogue and never another hospital's values.
    expect(body.options.services).toEqual(["Cataract", "LASIK"]);
    expect(body.options.sources.map((o) => o.key)).toEqual(["google", "instagram", "walk_in"]);
  });

  it("each quick view returns exactly the leads that match it, from real data", async () => {
    expect(rowNames((await ws("view=new_today")).body)).toEqual(["Cancelled Chitra", "Foreign Fiona"].filter(() => false).concat(["Newt Today"]));
    expect(rowNames((await ws("view=uncontacted")).body)).toEqual(["Cancelled Chitra", "Newt Today", "Old Uncontacted Uma"]);
    expect(rowNames((await ws("view=follow_up_due")).body)).toEqual(["Overdue Olive"]);
    expect(rowNames((await ws("view=follow_up_due&due=overdue")).body)).toEqual(["Overdue Olive"]);
    expect(rowNames((await ws("view=appointments_today")).body)).toEqual(["Booked Today Bina"]);
    expect(rowNames((await ws("view=appointment_booked")).body)).toEqual(["Booked Later Lata", "Booked Today Bina"]);
    expect(rowNames((await ws("view=lost")).body)).toEqual(["Lost Lalit"]);
    expect(rowNames((await ws("view=today")).body)).toEqual(["Booked Today Bina", "Newt Today", "Overdue Olive"]);
  });

  it("every count reconciles with its rows, and the today strip with the views it opens", async () => {
    const all = (await ws()).body;
    for (const v of LEAD_VIEWS) expect((await ws(`view=${v.key}`)).body.rows.length, v.key).toBe(all.counts[v.key]);
    expect(all.today.appointmentsToday).toBe(all.counts.appointments_today);
    expect(all.today.followUpsDue).toBe(all.counts.follow_up_due);
    expect(all.today.newToday).toBe(all.counts.new_today);
    expect(all.today.overdue).toBe((await ws("view=follow_up_due&due=overdue")).body.rows.length);
  });

  it("date range measures the enquiry date in hospital days, inclusive", async () => {
    expect(rowNames((await ws("range=today")).body)).toEqual(["Newt Today"]);
    expect(rowNames((await ws("range=7d")).body)).toEqual(["Booked Later Lata", "Booked Today Bina", "Cancelled Chitra", "Lost Lalit", "Newt Today", "Tomorrow Tara"]);
    expect(rowNames((await ws(`range=custom&from=${dayIST(-11)}&to=${dayIST(-9)}`)).body)).toEqual(["Overdue Olive"]);
    const w = (await ws("range=30d")).body;
    expect(w.period).toMatchObject({ range: "30d", from: dayIST(-29), to: dayIST(0) });
    expect(w.dateContext.kind).toBe("created");
    // Counts follow the range: tabs and rows never disagree.
    expect(w.counts.all).toBe(7);
    expect((await ws("range=30d&view=all")).body.rows).toHaveLength(7);
  });

  it("Follow-up Due and the today views state their own date context instead of mixing dates", async () => {
    expect((await ws("view=follow_up_due&range=7d")).body.dateContext.kind).toBe("follow_up_due");
    expect(rowNames((await ws(`view=follow_up_due&range=custom&from=${dayIST(1)}&to=${dayIST(1)}`)).body)).toEqual(["Tomorrow Tara"]);
    for (const view of ["today", "new_today", "appointments_today"]) {
      const a = (await ws(`view=${view}&range=30d`)).body;
      expect(a.dateContext.kind).toBe("today");
      expect(rowNames(a)).toEqual(rowNames((await ws(`view=${view}`)).body));
    }
  });

  it("owner filter: mine is the SESSION user; unassigned; a specific owner; counts reflect it", async () => {
    const mine = (await ws("owner=mine")).body;
    expect(rowNames(mine)).toEqual(["Overdue Olive"]);
    expect(mine.counts.all).toBe(1);
    expect((await ws("owner=unassigned")).body.counts.all).toBe(7);
    expect(rowNames((await ws(`owner=${t.userIds.PATIENT_COORDINATOR}`)).body)).toEqual(["Overdue Olive"]);
    // The admin's "mine" is a different person: nobody owns anything there.
    expect((await ws("owner=mine", t, "HOSPITAL_ADMIN")).body.rows).toHaveLength(0);
    const oc = mine.ownerCounts;
    expect(oc.all).toBe(8); // owner counts ignore the owner filter itself
    expect(oc.unassigned).toBe(7);
    expect(oc.byOwner).toEqual([{ userId: t.userIds.PATIENT_COORDINATOR, name: expect.any(String), count: 1 }]);
  });

  it("source and service filters (the hospital's own catalogue and the enquiry type)", async () => {
    expect(rowNames((await ws("source=instagram")).body)).toEqual(["Newt Today"]);
    expect(rowNames((await ws("source=walk_in")).body)).toEqual(["Old Uncontacted Uma"]);
    expect(rowNames((await ws("service=LASIK")).body)).toEqual(["Old Uncontacted Uma"]);
    expect((await ws("service=LASIK&source=instagram")).body.rows).toHaveLength(0);
  });

  it("rejects malformed queries with 400 and never trusts a tenant id from the query", async () => {
    expect((await ws("view=bogus")).status).toBe(400);
    expect((await ws("range=custom")).status).toBe(400); // custom needs from + to
    expect((await ws(`range=custom&from=${dayIST(0)}&to=${dayIST(-3)}`)).status).toBe(400);
    expect((await ws(`range=custom&from=${dayIST(0)}&to=${dayIST(3)}`)).status).toBe(200); // the future is fine: tomorrow's callbacks
    expect((await ws(`range=custom&from=${dayIST(-400)}&to=${dayIST(0)}`)).status).toBe(400); // more than a year
    expect((await ws("owner=not-a-uuid")).status).toBe(400);
    const smuggled = await ws(`tenantId=${other.tenantId}`);
    expect(smuggled.status).toBe(200);
    expect(rowNames(smuggled.body)).not.toContain("Foreign Fiona");
    // The other hospital sees only its own.
    expect(rowNames((await ws("", other)).body)).toEqual(["Foreign Fiona"]);
  });
});
