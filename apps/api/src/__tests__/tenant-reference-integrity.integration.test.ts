import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { queryClient } from "../db/client.js";
import type { FastifyInstance } from "fastify";

// Every id a client sends (branch, assignee...) must belong to the SESSION's hospital. A foreign UUID is refused up
// front — never stored and never resolved into another hospital's name.

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

describe.skipIf(!DEMO_PASSWORD)("tenant reference integrity (integration)", () => {
  let app: FastifyInstance;
  let cookie: string;
  let tenantId: string;
  let foreignBranchId: string;
  let foreignUserId: string;
  let ownBranchId: string;

  const as = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as object | undefined, cookies: { pulseos_session: cookie } });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "gyn.admin@pulseos.local", password: DEMO_PASSWORD } });
    cookie = login.cookies.find((c) => c.name === "pulseos_session")!.value;
    const [u] = await queryClient`select tenant_id from users where email = 'gyn.admin@pulseos.local'`;
    tenantId = u!.tenant_id as string;
    const [fb] = await queryClient`select id from branches where tenant_id <> ${tenantId} limit 1`;
    foreignBranchId = fb!.id as string;
    const [fu] = await queryClient`select id from users where tenant_id <> ${tenantId} limit 1`;
    foreignUserId = fu!.id as string;
    const [ob] = await queryClient`select id from branches where tenant_id = ${tenantId} limit 1`;
    ownBranchId = ob!.id as string;
  });

  afterAll(async () => {
    // A routed create also writes a journey + timeline, so remove the probes' dependents first.
    const probes = await queryClient`select id from patients where tenant_id = ${tenantId} and phone like '+9198000001%'`;
    const ids = probes.map((r) => r.id as string);
    if (ids.length) {
      await queryClient`delete from tasks where patient_id = any(${ids})`;
      await queryClient`delete from timeline_events where patient_id = any(${ids})`;
      await queryClient`delete from journeys where patient_id = any(${ids})`;
      await queryClient`delete from patients where id = any(${ids})`;
    }
    await app.close();
    await queryClient.end();
  });

  it("refuses to create a patient in a branch of another hospital", async () => {
    const res = await as("POST", "/patients", { name: "Foreign Branch Probe", phone: "+919800000101", branchId: foreignBranchId });
    expect(res.statusCode).toBe(400);
    const rows = await queryClient`select id from patients where tenant_id = ${tenantId} and phone = '+919800000101'`;
    expect(rows).toHaveLength(0);
  });

  it("still creates a patient in the hospital's own branch", async () => {
    const res = await as("POST", "/patients", { name: "Own Branch Probe", phone: "+919800000102", branchId: ownBranchId });
    expect(res.statusCode).toBeLessThan(300);
    const [p] = await queryClient`select id, branch_id from patients where tenant_id = ${tenantId} and phone = '+919800000102'`;
    expect(p!.branch_id).toBe(ownBranchId);
  });

  it("never resolves another hospital's branch name into Patient 360", async () => {
    // A row from before the check existed: a patient pointing at a foreign branch.
    const [p] = await queryClient`
      insert into patients (tenant_id, name, phone, branch_id) values (${tenantId}, 'Legacy Foreign Branch', '+919800000103', ${foreignBranchId}) returning id`;
    const res = await as("GET", `/patients/${p!.id}/360`);
    expect(res.statusCode).toBe(200);
    expect(res.json().patient?.branchName ?? res.json().branchName ?? null).toBeNull();
  });

  it("refuses to assign a conversation to a user of another hospital", async () => {
    const [c] = await queryClient`select id from conversations where tenant_id = ${tenantId} and ownership_state <> 'CLOSED' limit 1`;
    test_skip_if(!c);
    const [before] = await queryClient`select assigned_to, ownership_state from conversations where id = ${c!.id}`;
    const res = await as("PATCH", `/conversations/${c!.id}/assign`, { assignedTo: foreignUserId });
    expect(res.statusCode).toBe(404);
    const [after] = await queryClient`select assigned_to, ownership_state from conversations where id = ${c!.id}`;
    expect(after).toEqual(before); // nothing was changed
  });

  it("refuses a communication endpoint pointing at another hospital's branch", async () => {
    const [conn] = await queryClient`select id from connectors where tenant_id = ${tenantId} and provider = 'superfone' limit 1`;
    test_skip_if(!conn);
    const res = await as("POST", `/connectors/${conn!.id}/endpoints`, {
      type: "CALL", publicNumber: "+911100000099", providerRef: `probe-${Date.now()}`, displayLabel: "Probe", branchId: foreignBranchId,
    });
    expect(res.statusCode).toBe(404);
  });
});

function test_skip_if(condition: boolean): void {
  if (condition) throw new Error("fixture missing in this database — reseed (pnpm db:seed) before running");
}
