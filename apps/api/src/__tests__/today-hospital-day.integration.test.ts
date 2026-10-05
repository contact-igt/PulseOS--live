import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { journeys, patients } from "../db/schema.js";
import type { FastifyInstance } from "fastify";

// Command Centre's Today strip and Leads' "New today" count the HOSPITAL's
// day (tenants.timezone), never the API server's clock zone. Run with TZ=UTC
// to see the difference: an enquiry at 00:30 IST today is still "today".
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const istDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

describe.skipIf(!DEMO_PASSWORD)("'today' on Command Centre and Leads is the hospital day (integration)", () => {
  let app: FastifyInstance;
  let cookie: string;
  let patientId: string;

  const get = async (url: string) => (await app.inject({ method: "GET", url, cookies: { pulseos_session: cookie } })).json();

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "eye.admin@pulseos.local", password: DEMO_PASSWORD } });
    cookie = res.cookies.find((c) => c.name === "pulseos_session")!.value;
    const tenantId = res.json().user.tenantId as string;
    const [p] = await db.insert(patients).values({ tenantId, name: "Early Hours Enquiry", phone: "+910000000002" }).returning();
    patientId = p.id;
  });

  afterAll(async () => {
    await db.delete(journeys).where(eq(journeys.patientId, patientId));
    await db.delete(patients).where(eq(patients.id, patientId));
    await app.close();
    await queryClient.end();
  });

  it("an enquiry at 00:30 IST today counts in the Today strip and as New today", async () => {
    const before = { strip: (await get("/dashboard/today")).newEnquiries as number, leads: (await get("/leads/summary")).newToday as number };
    const tenantId = (await get("/auth/session")).user.tenantId as string;
    await db.insert(journeys).values({ tenantId, patientId, journeyType: "Cataract", source: "meta", stage: "enquiry", createdAt: new Date(`${istDay(new Date())}T00:30:00+05:30`) });
    expect((await get("/dashboard/today")).newEnquiries).toBe(before.strip + 1);
    expect((await get("/leads/summary")).newToday).toBe(before.leads + 1);
  });
});
