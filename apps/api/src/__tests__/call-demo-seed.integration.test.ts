import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, queryClient } from "../db/client.js";
import { callIntelligence, calls, journeys, tasks, tenants } from "../db/schema.js";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

// The seeded Ophthalmology demo tenants show all three call stories (built through the real call code paths).
describe.skipIf(!DEMO_PASSWORD)("Ophthalmology demo call data (seed guarantees)", () => {
  afterAll(() => queryClient.end());

  for (const name of ["PulseOS Ophthalmology V1 Demo", "PulseOS Ophthalmology Demo"]) {
    describe(name, () => {
      const tenantId = async () => (await db.select().from(tenants).where(eq(tenants.name, name)))[0]!.id;
      const callsOn = async (specialtyKey: string) => {
        const t = await tenantId();
        const js = await db.select().from(journeys).where(and(eq(journeys.tenantId, t), eq(journeys.specialtyKey, specialtyKey)));
        const all = await db.select().from(calls).where(eq(calls.tenantId, t));
        return all.filter((c) => js.some((j) => j.id === c.journeyId));
      };

      it("a Cataract journey has an IVR call with a fixture recording, a transcript, a demo-labelled summary and the coordinator's own feedback + callback", async () => {
        const c = (await callsOn("CATARACT")).find((x) => x.origin === "IVR" && x.recordingUrl);
        expect(c).toBeTruthy();
        expect(c!.recordingUrl).toBe("pulseos-fixture://silence.wav");
        const intel = (await db.select().from(callIntelligence).where(eq(callIntelligence.callId, c!.id)))[0]!;
        expect(intel).toMatchObject({ transcriptStatus: "COMPLETED", transcriptMode: "FIXTURE", summaryStatus: "COMPLETED", summaryMode: "FIXTURE" });
        expect(c!.staffFeedback).toBe("Patient will confirm after speaking with family.");
        expect(intel.summary).not.toBe(c!.staffFeedback);
        const task = (await db.select().from(tasks).where(eq(tasks.id, c!.callbackTaskId!)))[0]!;
        expect(task).toMatchObject({ type: "FOLLOW_UP", status: "pending" });
      });

      it("a Laser Vision Correction journey has a call the front desk logged by hand", async () => {
        const manual = (await callsOn("LASER_VISION_CORRECTION")).find((c) => c.origin === "MANUAL");
        expect(manual).toMatchObject({ direction: "outbound", status: "completed", connectorId: null });
        expect(manual!.staffFeedback).toBeTruthy();
      });

      it("a missed IVR call has its callback Task waiting", async () => {
        const missed = (await callsOn("SQUINT")).find((c) => c.status === "missed" && c.origin === "IVR");
        expect(missed).toBeTruthy();
        const ts = await db.select().from(tasks).where(and(eq(tasks.journeyId, missed!.journeyId!), eq(tasks.reason, "missed_follow_up")));
        expect(ts).toHaveLength(1);
        expect(ts[0]).toMatchObject({ type: "CALLBACK", status: "pending" });
      });
    });
  }
});
