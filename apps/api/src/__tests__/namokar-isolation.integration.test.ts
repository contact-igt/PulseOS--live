import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { queryClient } from "../db/client.js";

// V1 Demo and V2 Pilot are two separate hospitals in one app. This probes the seeded pair directly (read-only: nothing is created
// or changed because every mutation below must be REFUSED): ids from one workspace are useless in the other, and the people who
// should not touch settings, secrets or assignment cannot.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe.skipIf(!DEMO_PASSWORD)("Namokar V1 / V2 isolation and permissions (seeded)", () => {
  let app: FastifyInstance;
  const cookie: Record<string, string> = {};
  const ids: { v1Journey: string; v1Patient: string; v1Connector: string; v1UserId: string; v2Doctor: string; v2Branch: string; v2UserId: string; v1Doctor: string; v1Branch: string } = {} as never;

  const call = (who: string, method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object) => app.inject({ method, url, cookies: { pulseos_session: cookie[who]! }, ...(payload ? { payload } : {}) });
  async function login(key: string, email: string) {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
    expect(res.statusCode, email).toBe(200);
    cookie[key] = res.cookies.find((c) => c.name === "pulseos_session")!.value;
    return res.json() as { user: { id: string } };
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    ids.v1UserId = (await login("v1admin", "namokar.admin@pulseos.local")).user.id;
    await login("v1front", "namokar.frontdesk@pulseos.local");
    await login("v1coord", "namokar.coordinator@pulseos.local");
    await login("v1doctor", "namokar.doctor@pulseos.local");
    await login("v2admin", "namokarv2.admin@pulseos.local");
    await login("v2front", "namokarv2.frontdesk@pulseos.local");
    ids.v2UserId = (await login("v2shivani", "namokarv2.shivani@pulseos.local")).user.id;
    const journeys = (await call("v1admin", "GET", "/journeys")).json() as { id: string; patientId: string }[];
    ids.v1Journey = journeys[0]!.id;
    ids.v1Patient = journeys[0]!.patientId;
    ids.v1Connector = ((await call("v1admin", "GET", "/connectors")).json() as { id: string }[])[0]!.id;
    const l1 = (await call("v1front", "GET", "/lookups")).json() as { doctors: { id: string }[]; branches: { id: string }[] };
    const l2 = (await call("v2front", "GET", "/lookups")).json() as { doctors: { id: string }[]; branches: { id: string }[] };
    [ids.v1Doctor, ids.v1Branch, ids.v2Doctor, ids.v2Branch] = [l1.doctors[0]!.id, l1.branches[0]!.id, l2.doctors[0]!.id, l2.branches[0]!.id];
  });
  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("V2 sees none of V1's patients, journeys or connectors", async () => {
    expect((await call("v2admin", "GET", `/journeys/${ids.v1Journey}`)).statusCode).toBeGreaterThanOrEqual(403);
    expect((await call("v2admin", "GET", `/patients/${ids.v1Patient}`)).statusCode).toBeGreaterThanOrEqual(403);
    expect((await call("v2admin", "GET", `/connectors/${ids.v1Connector}`)).statusCode).toBeGreaterThanOrEqual(403);
    expect(await (await call("v2admin", "GET", "/journeys")).json()).toEqual([]);
    expect(await (await call("v2admin", "GET", "/connectors")).json()).toEqual([]);
  });

  it("changing the Assigned Team Member is tenant-scoped, both ways", async () => {
    // V2's admin cannot reassign a V1 journey ...
    expect((await call("v2admin", "PATCH", `/journeys/${ids.v1Journey}/owner`, { ownerUserId: ids.v2UserId })).statusCode).toBeGreaterThanOrEqual(400);
    // ... and V1's admin cannot hand a V1 journey to a V2 person.
    const res = await call("v1admin", "PATCH", `/journeys/${ids.v1Journey}/owner`, { ownerUserId: ids.v2UserId });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const after = (await call("v1admin", "GET", `/journeys/${ids.v1Journey}`)).json() as { ownerUserId?: string | null; owner?: { id: string } | null };
    expect(after.ownerUserId ?? after.owner?.id ?? null).not.toBe(ids.v2UserId);
  });

  it("one workspace's doctor / branch ids cannot be used to book in the other", async () => {
    const scheduledAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const lead = (await call("v1admin", "GET", "/journeys")).json() as { id: string; patientId: string }[];
    const mine = { patientId: lead[0]!.patientId, journeyId: lead[0]!.id, scheduledAt, reason: "isolation probe" };
    expect((await call("v1front", "POST", "/appointments", { ...mine, doctorId: ids.v2Doctor, branchId: ids.v2Branch })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await call("v1front", "POST", "/appointments", { ...mine, doctorId: ids.v1Doctor, branchId: ids.v2Branch })).statusCode).toBeGreaterThanOrEqual(400);
  });

  it("front desk, coordinator and doctor cannot read or change integration secrets", async () => {
    for (const who of ["v1front", "v1coord", "v1doctor"]) {
      expect((await call(who, "PATCH", `/connectors/${ids.v1Connector}`, { secrets: { intakeToken: "should-not-be-written" } })).statusCode, who).toBe(403);
    }
    // And nobody gets a secret back from the read path.
    const body = (await call("v1admin", "GET", `/connectors/${ids.v1Connector}`)).body;
    expect(body).not.toMatch(/intakeToken|accessToken|appSecret|encryptedPayload|FIXTURE_NAMOKAR_TOKEN/i);
  });

  it("doctor and front desk cannot change settings; clinic hours and features are admin-only", async () => {
    for (const who of ["v1front", "v1coord", "v1doctor"]) {
      expect((await call(who, "PUT", "/clinic-hours", { clinicHours: null })).statusCode, who).toBe(403);
      expect((await call(who, "PUT", "/capabilities/WHATSAPP_NOTIFICATIONS", { enabled: false })).statusCode, who).toBe(403);
    }
  });
});
