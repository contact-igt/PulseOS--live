import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { buildApp } from "../app.js";
import { queryClient } from "../db/client.js";
import type { FastifyInstance } from "fastify";
import type { ConnectorRow, CommunicationEndpointVm } from "@pulseos/types";

const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

// Endpoint providerRefs are unique per connector and never cleaned up, so fixed values would 409 on the second run against the same DB.
const RUN = Date.now().toString(36);
const MAIN_REF = `main-reception-line-${RUN}`;
const WA_REF = `phone-number-id-fertility-${RUN}`;

async function loginAs(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: DEMO_PASSWORD } });
  return res.cookies.find((c) => c.name === "pulseos_session")!.value;
}

describe.skipIf(!DEMO_PASSWORD)("communication endpoints (integration)", () => {
  let app: FastifyInstance;
  let adminCookie: string;
  let frontDeskCookie: string;
  let doctorCookie: string;
  let runoConnectorId: string;
  let whatsappConnectorId: string;
  let branchAId: string;
  let branchBId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    adminCookie = await loginAs(app, "gyn.admin@pulseos.local");
    frontDeskCookie = await loginAs(app, "gyn.frontdesk@pulseos.local");
    doctorCookie = await loginAs(app, "gyn.doctor@pulseos.local");

    const connectorList = await app.inject({ method: "GET", url: "/connectors", cookies: { pulseos_session: adminCookie } });
    const connectors = connectorList.json() as ConnectorRow[];
    runoConnectorId = connectors.find((c) => c.provider === "runo")!.id;
    whatsappConnectorId = connectors.find((c) => c.provider === "whatsapp_meta_cloud")!.id;

    const branchList = await app.inject({ method: "GET", url: "/branches", cookies: { pulseos_session: adminCookie } });
    const branches = branchList.json() as { id: string }[];
    branchAId = branches[0]!.id;
    branchBId = branches[1]?.id ?? branches[0]!.id;
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  it("rejects an unauthenticated request with 401", async () => {
    const res = await app.inject({ method: "GET", url: `/connectors/${runoConnectorId}/endpoints` });
    expect(res.statusCode).toBe(401);
  });

  // Reading the endpoint list is a narrower capability than the rest of
  // Integrations (which front desk genuinely shouldn't see — connector
  // secrets status, sync controls, raw provider config). Front desk and
  // coordinators need to know "which hospital line is this conversation on"
  // for the Inbox filter, so they get VIEW_COMMUNICATION_ENDPOINTS even
  // without VIEW_INTEGRATIONS. Doctor has neither and stays blocked.
  it("front desk (VIEW_COMMUNICATION_ENDPOINTS but no VIEW_INTEGRATIONS) can view endpoints", async () => {
    const res = await app.inject({ method: "GET", url: `/connectors/${runoConnectorId}/endpoints`, cookies: { pulseos_session: frontDeskCookie } });
    expect(res.statusCode).toBe(200);
  });

  it("doctor (no VIEW_COMMUNICATION_ENDPOINTS) cannot view endpoints", async () => {
    const res = await app.inject({ method: "GET", url: `/connectors/${runoConnectorId}/endpoints`, cookies: { pulseos_session: doctorCookie } });
    expect(res.statusCode).toBe(403);
  });

  it("front desk cannot create an endpoint (no MANAGE_INTEGRATIONS)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/connectors/${runoConnectorId}/endpoints`,
      cookies: { pulseos_session: frontDeskCookie },
      payload: { type: "PHONE", publicNumber: "+919100000010", providerRef: "front-desk-line", displayLabel: "Should Not Create" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("creates multiple endpoints for the same tenant, on different branches, phone + WhatsApp", async () => {
    const phoneRes = await app.inject({
      method: "POST",
      url: `/connectors/${runoConnectorId}/endpoints`,
      cookies: { pulseos_session: adminCookie },
      payload: { branchId: branchAId, type: "PHONE", publicNumber: "+919100000011", providerRef: MAIN_REF, displayLabel: "Main Reception" },
    });
    expect(phoneRes.statusCode).toBe(201);
    const phoneEndpoint = phoneRes.json() as CommunicationEndpointVm;
    expect(phoneEndpoint.type).toBe("PHONE");
    expect(phoneEndpoint.connectorId).toBe(runoConnectorId);
    expect(phoneEndpoint.connectorProvider).toBe("runo");
    expect(phoneEndpoint.branchId).toBe(branchAId);
    expect(phoneEndpoint.isActive).toBe(true);

    const waRes = await app.inject({
      method: "POST",
      url: `/connectors/${whatsappConnectorId}/endpoints`,
      cookies: { pulseos_session: adminCookie },
      payload: { branchId: branchBId, type: "WHATSAPP", publicNumber: "+919100000012", providerRef: WA_REF, displayLabel: "Fertility Line" },
    });
    expect(waRes.statusCode).toBe(201);
    const waEndpoint = waRes.json() as CommunicationEndpointVm;
    expect(waEndpoint.type).toBe("WHATSAPP");
    expect(waEndpoint.connectorProvider).toBe("whatsapp_meta_cloud");
    expect(waEndpoint.branchId).toBe(branchBId);

    const listRes = await app.inject({ method: "GET", url: "/communication-endpoints", cookies: { pulseos_session: adminCookie } });
    expect(listRes.statusCode).toBe(200);
    const all = listRes.json() as CommunicationEndpointVm[];
    const ids = all.map((e) => e.id);
    expect(ids).toContain(phoneEndpoint.id);
    expect(ids).toContain(waEndpoint.id);
  });

  it("scopes the list to a single connector when connectorId is provided", async () => {
    const res = await app.inject({ method: "GET", url: `/connectors/${runoConnectorId}/endpoints`, cookies: { pulseos_session: adminCookie } });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as CommunicationEndpointVm[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.connectorId).toBe(runoConnectorId);
  });

  it("rejects a duplicate providerRef on the same connector", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/connectors/${runoConnectorId}/endpoints`,
      cookies: { pulseos_session: adminCookie },
      payload: { type: "PHONE", publicNumber: "+919100000013", providerRef: MAIN_REF, displayLabel: "Duplicate" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("provider_ref_already_exists");
  });

  it("404s creating an endpoint under a connector id from a different tenant (tenant isolation)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/connectors/00000000-0000-0000-0000-000000000000/endpoints",
      cookies: { pulseos_session: adminCookie },
      payload: { type: "PHONE", publicNumber: "+919100000014", providerRef: "nonexistent-connector-line", displayLabel: "Nope" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("connector_not_found");
  });

  it("resolves an endpoint by connector + providerRef", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/connectors/${runoConnectorId}/endpoints/resolve?providerRef=${MAIN_REF}`,
      cookies: { pulseos_session: adminCookie },
    });
    expect(res.statusCode).toBe(200);
    const endpoint = res.json() as CommunicationEndpointVm;
    expect(endpoint.providerRef).toBe(MAIN_REF);
    expect(endpoint.connectorId).toBe(runoConnectorId);
  });

  it("404s resolving an unknown providerRef", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/connectors/${runoConnectorId}/endpoints/resolve?providerRef=does-not-exist`,
      cookies: { pulseos_session: adminCookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("endpoint_not_found");
  });

  it("updates displayLabel, branchId, and isActive on an owned endpoint, reflected in a subsequent list", async () => {
    const providerRef = `update-test-line-${Date.now()}`;
    const createRes = await app.inject({
      method: "POST",
      url: `/connectors/${runoConnectorId}/endpoints`,
      cookies: { pulseos_session: adminCookie },
      payload: { branchId: branchAId, type: "PHONE", publicNumber: "+919100000020", providerRef, displayLabel: "Update Me" },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json() as CommunicationEndpointVm;

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/connectors/${runoConnectorId}/endpoints/${created.id}`,
      cookies: { pulseos_session: adminCookie },
      payload: { displayLabel: "Updated Label", branchId: branchBId, isActive: false },
    });
    expect(patchRes.statusCode).toBe(200);
    const updated = patchRes.json() as CommunicationEndpointVm;
    expect(updated.displayLabel).toBe("Updated Label");
    expect(updated.branchId).toBe(branchBId);
    expect(updated.isActive).toBe(false);

    const listRes = await app.inject({ method: "GET", url: `/connectors/${runoConnectorId}/endpoints`, cookies: { pulseos_session: adminCookie } });
    const rows = listRes.json() as CommunicationEndpointVm[];
    const row = rows.find((r) => r.id === created.id);
    expect(row?.displayLabel).toBe("Updated Label");
    expect(row?.branchId).toBe(branchBId);
    expect(row?.isActive).toBe(false);

    const clearBranchRes = await app.inject({
      method: "PATCH",
      url: `/connectors/${runoConnectorId}/endpoints/${created.id}`,
      cookies: { pulseos_session: adminCookie },
      payload: { branchId: null },
    });
    expect(clearBranchRes.statusCode).toBe(200);
    expect(clearBranchRes.json().branchId).toBeNull();
  });

  it("reactivates a deactivated endpoint", async () => {
    const providerRef = `reactivate-test-line-${Date.now()}`;
    const createRes = await app.inject({
      method: "POST",
      url: `/connectors/${runoConnectorId}/endpoints`,
      cookies: { pulseos_session: adminCookie },
      payload: { type: "PHONE", publicNumber: "+919100000021", providerRef, displayLabel: "Reactivate Me" },
    });
    const created = createRes.json() as CommunicationEndpointVm;

    const deactivateRes = await app.inject({
      method: "PATCH",
      url: `/connectors/${runoConnectorId}/endpoints/${created.id}`,
      cookies: { pulseos_session: adminCookie },
      payload: { isActive: false },
    });
    expect(deactivateRes.statusCode).toBe(200);
    expect(deactivateRes.json().isActive).toBe(false);

    const reactivateRes = await app.inject({
      method: "PATCH",
      url: `/connectors/${runoConnectorId}/endpoints/${created.id}`,
      cookies: { pulseos_session: adminCookie },
      payload: { isActive: true },
    });
    expect(reactivateRes.statusCode).toBe(200);
    expect(reactivateRes.json().isActive).toBe(true);
  });

  it("front desk cannot update an endpoint (no MANAGE_INTEGRATIONS)", async () => {
    const providerRef = `frontdesk-blocked-line-${Date.now()}`;
    const createRes = await app.inject({
      method: "POST",
      url: `/connectors/${runoConnectorId}/endpoints`,
      cookies: { pulseos_session: adminCookie },
      payload: { type: "PHONE", publicNumber: "+919100000022", providerRef, displayLabel: "Front Desk Blocked" },
    });
    const created = createRes.json() as CommunicationEndpointVm;

    const res = await app.inject({
      method: "PATCH",
      url: `/connectors/${runoConnectorId}/endpoints/${created.id}`,
      cookies: { pulseos_session: frontDeskCookie },
      payload: { displayLabel: "Should Not Update" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("404s updating an endpoint id that does not exist", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/connectors/${runoConnectorId}/endpoints/00000000-0000-0000-0000-000000000000`,
      cookies: { pulseos_session: adminCookie },
      payload: { displayLabel: "Nope" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("endpoint_not_found");
  });

  it("404s updating an endpoint id that belongs to a different connector (connector + tenant scoping)", async () => {
    const providerRef = `connector-scope-line-${Date.now()}`;
    const createRes = await app.inject({
      method: "POST",
      url: `/connectors/${runoConnectorId}/endpoints`,
      cookies: { pulseos_session: adminCookie },
      payload: { type: "PHONE", publicNumber: "+919100000023", providerRef, displayLabel: "Connector Scoped" },
    });
    const created = createRes.json() as CommunicationEndpointVm;

    // `created` belongs to runoConnectorId — attempting to update it through
    // whatsappConnectorId's URL must not succeed, the same way a mismatched
    // tenant/connector combination must not.
    const res = await app.inject({
      method: "PATCH",
      url: `/connectors/${whatsappConnectorId}/endpoints/${created.id}`,
      cookies: { pulseos_session: adminCookie },
      payload: { displayLabel: "Should Not Update" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("endpoint_not_found");
  });
});
