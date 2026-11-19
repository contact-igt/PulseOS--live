import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { platformIdentities } from "../db/schema.js";
import { digest } from "../domain/tenant/hospital-onboarding.service.js";
import { installDepartmentTemplate } from "../domain/specialty/department.service.js";
import { provisionHospital } from "../domain/tenant/hospital-provisioning.service.js";
import { destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

vi.mock("../domain/specialty/department.service.js", async (original) => {
  const actual = await original<typeof import("../domain/specialty/department.service.js")>();
  return { ...actual, installDepartmentTemplate: vi.fn(actual.installDepartmentTemplate) };
});
vi.mock("../domain/tenant/hospital-provisioning.service.js", async (original) => {
  const actual = await original<typeof import("../domain/tenant/hospital-provisioning.service.js")>();
  return { ...actual, provisionHospital: vi.fn(actual.provisionHospital) };
});

const password = "Correct-Horse-9";
const tag = randomUUID().slice(0, 8);
const valid = (suffix: string, overrides: Record<string, unknown> = {}) => ({
  fullName: "Asha Verma", email: `onboarding.${tag}.${suffix}@example.test`, phone: "+91 98765 43210",
  organizationName: `Sunrise ${tag} ${suffix}`, industry: "Healthcare", organizationType: "Eye Hospital",
  department: "Ophthalmology", addressLine: "12 MG Road", city: "Bengaluru", state: "Karnataka",
  pinCode: "560038", country: "India", discoverySource: "Google", edition: "V1", ...overrides,
});

describe("platform-managed hospital onboarding (integration)", () => {
  let app: FastifyInstance;
  const ids = new Set<string>();
  const operator = randomBytes(32).toString("base64url");
  const wrongRole = randomBytes(32).toString("base64url");
  const expiredOperator = randomBytes(32).toString("base64url");
  const revokedOperator = randomBytes(32).toString("base64url");
  const authorization = `Bearer ${operator}`;
  const create = (body: object, id = randomUUID(), headers: Record<string, string> = {}) => {
    ids.add(id);
    return app.inject({ method: "POST", url: "/platform/hospitals", payload: body, headers: { authorization, "idempotency-key": id, ...headers } });
  };
  const action = (id: string, name: string) =>
    app.inject({ method: "POST", url: `/platform/hospitals/${id}/${name}`, headers: { authorization } });
  const status = (id: string) =>
    app.inject({ method: "GET", url: `/platform/hospitals/${id}`, headers: { authorization } });
  const accept = (token: string) =>
    app.inject({ method: "POST", url: "/auth/hospital-invitations/redeem", payload: { token, password } });
  const tokenFrom = (invitationPath: string) => invitationPath.split("#")[1]!;
  const login = (email: string, slug?: string) => app.inject({
    method: "POST", url: slug ? `/auth/login/tenant/${slug}` : "/auth/login", payload: { email, password },
  });

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const expiresAt = new Date(Date.now() + 300_000);
    await db.insert(platformIdentities).values([
      { label: `operator-${tag}`, role: "HOSPITAL_ONBOARDING_ADMIN", credentialHash: digest(operator), expiresAt },
      { label: `wrong-role-${tag}`, role: "READ_ONLY", credentialHash: digest(wrongRole), expiresAt },
      { label: `expired-${tag}`, role: "HOSPITAL_ONBOARDING_ADMIN", credentialHash: digest(expiredOperator), expiresAt: new Date(0) },
      { label: `revoked-${tag}`, role: "HOSPITAL_ONBOARDING_ADMIN", credentialHash: digest(revokedOperator), expiresAt, revokedAt: new Date() },
    ]);
  });

  afterAll(async () => {
    for (const id of ids) {
      const [row] = await queryClient`select tenant_id from hospital_onboardings where id = ${id}`;
      await queryClient`delete from platform_audit_log where onboarding_id = ${id}`;
      await queryClient`delete from hospital_onboardings where id = ${id}`;
      if (row?.tenant_id) {
        await queryClient`delete from tenant_profiles where tenant_id = ${row.tenant_id}`;
        await destroyTestTenant(db, { tenantId: row.tenant_id } as TestTenant);
      }
    }
    await queryClient`delete from platform_identities where label = any(${[`operator-${tag}`, `wrong-role-${tag}`, `expired-${tag}`, `revoked-${tag}`]})`;
    await app.close();
    await queryClient.end();
  });

  it("closes public signup and checks platform credentials, role, expiry, revocation and strict input", async () => {
    const body = valid("closed");
    const rejected = await app.inject({ method: "POST", url: "/auth/signup", payload: { ...body, password } });
    expect(rejected.statusCode).toBe(410);
    expect(rejected.cookies).toHaveLength(0);
    expect(await queryClient`select id from tenants where name = ${body.organizationName}`).toHaveLength(0);
    for (const token of ["", wrongRole, expiredOperator, revokedOperator]) {
      expect((await create(body, randomUUID(), { authorization: token ? `Bearer ${token}` : "" })).statusCode).toBe(401);
    }
    expect((await create({ ...body, password })).statusCode).toBe(400);
    expect((await create({ ...body, tenantId: randomUUID() })).statusCode).toBe(400);
    expect((await create({ ...body, department: undefined })).statusCode).toBe(400);
  });

  it("uses shared provisioning, gates login and isolates platform and tenant sessions", async () => {
    const input = valid("full", { edition: "V2" });
    const result = await create(input);
    expect(result.statusCode).toBe(201);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.cookies).toHaveLength(0);
    expect(provisionHospital).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ email: input.email, edition: "BETA_V2_GROWTH" }));
    const { id, tenantId, loginPath } = result.json();
    const slug = loginPath.split("/").at(-1)!;
    expect(result.json()).toMatchObject({ active: false, ready: false, template: "installed", invitation: "not_issued" });
    const [owner] = await queryClient`select u.id, u.password_hash, u.role, b.tenant_id as branch_tenant from users u join branches b on b.id = u.branch_id where u.tenant_id = ${tenantId}`;
    expect(owner).toMatchObject({ role: "SUPER_ADMIN", branch_tenant: tenantId, password_hash: expect.stringMatching(/^\$argon2id\$/) });
    expect(await queryClient`select source, dev_visible, owner_phone from tenant_profiles where tenant_id = ${tenantId}`)
      .toEqual([{ source: "platform", dev_visible: false, owner_phone: "+919876543210" }]);
    expect(await queryClient`select 1 from tenant_login_configs where tenant_id = ${tenantId}`).toHaveLength(1);
    expect(await queryClient`select 1 from departments where tenant_id = ${tenantId}`).toHaveLength(1);
    expect((await action(id, "activate")).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: `/auth/tenants/${slug}` })).statusCode).toBe(404);

    const invitation = await action(id, "invitation");
    expect(invitation.statusCode).toBe(200);
    expect(invitation.headers["cache-control"]).toBe("no-store");
    expect(invitation.json().recipient).toBe(input.email);
    const token = tokenFrom(invitation.json().invitationPath);
    expect(await queryClient`select invitation_hash from hospital_onboardings where id = ${id}`).toEqual([{ invitation_hash: digest(token) }]);
    const accepts = await Promise.all([accept(token), accept(token)]);
    expect(accepts.map((res) => res.statusCode).sort()).toEqual([200, 400]);
    expect(accepts.every((res) => res.cookies.length === 0)).toBe(true);
    expect((await action(id, "invitation")).statusCode).toBe(409);
    expect((await status(id)).json()).toMatchObject({ ready: true, active: false, invitation: "accepted" });
    expect((await login(input.email)).statusCode).toBe(401);
    expect((await login(input.email, slug)).statusCode).toBe(401);
    expect(await queryClient`select id from sessions where user_id = ${owner!.id}`).toHaveLength(0);

    await queryClient`delete from tenant_login_configs where tenant_id = ${tenantId}`;
    expect((await status(id)).json()).toMatchObject({ ready: false, active: false });
    expect((await action(id, "activate")).statusCode).toBe(409);
    await queryClient`insert into tenant_login_configs (tenant_id) values (${tenantId})`;

    expect((await action(id, "activate")).json().hospital.active).toBe(true);
    expect((await action(id, "activate")).json().hospital.active).toBe(true);
    const branding = await app.inject({ method: "GET", url: `/auth/tenants/${slug}` });
    expect(branding.json()).toMatchObject({ displayName: input.organizationName, slug });
    const signedIn = await login(input.email, slug);
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.json().user).toMatchObject({ tenantId, role: "SUPER_ADMIN", edition: "BETA_V2_GROWTH" });
    const cookie = signedIn.cookies.find((c) => c.name === "pulseos_session")!.value;
    expect((await create(valid("tenant-cookie"), randomUUID(), { authorization: "", cookie: `pulseos_session=${cookie}` })).statusCode).toBe(403);
    expect((await create(valid("tenant-bearer"), randomUUID(), { authorization: `Bearer ${cookie}` })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/auth/session", headers: { authorization } })).statusCode).toBe(401);
    const dev = await app.inject({ method: "GET", url: "/auth/dev-login/environments" });
    if (dev.statusCode === 200) expect(dev.json()).not.toEqual(expect.arrayContaining([expect.objectContaining({ key: `tenant:${tenantId}` })]));

    const events = await queryClient`select action, actor_id from platform_audit_log where onboarding_id = ${id}`;
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining([
      "hospital_created", "template_installed", "activation_failed", "invitation_issued", "invitation_redeemed", "hospital_activated",
    ]));
    expect(events.filter((e) => e.action === "hospital_activated")).toHaveLength(1);
    expect(events.find((e) => e.action === "invitation_redeemed")?.actor_id).toBeNull();
  });

  it("serializes idempotency keys, case-insensitive owner email and shared slug allocation", async () => {
    const id = randomUUID();
    const input = valid("concurrent", { department: "ENT / Rhinology" });
    const [a, b] = await Promise.all([create(input, id), create(input, id)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.json()).toEqual(b.json());
    expect(a.json().template).toBe("none");
    expect((await create(valid("other"), id)).json()).toEqual({ error: "idempotency_conflict" });

    const another = valid("slug-a", { organizationName: input.organizationName, department: "ENT / Rhinology" });
    const [duplicateA, duplicateB] = await Promise.all([create(another), create({ ...another, email: another.email.toUpperCase() })]);
    expect([duplicateA.statusCode, duplicateB.statusCode].sort()).toEqual([201, 409]);
    expect((duplicateA.statusCode === 409 ? duplicateA : duplicateB).json().error).toBe("email_in_use");

    const [slugA, slugB] = await Promise.all([
      create(valid("slug-b", { organizationName: input.organizationName, department: "ENT / Rhinology" })),
      create(valid("slug-c", { organizationName: input.organizationName, department: "ENT / Rhinology" })),
    ]);
    const base = a.json().loginPath;
    expect([slugA.json().loginPath, slugB.json().loginPath].sort()).toEqual([`${base}-3`, `${base}-4`]);
  });

  it("records provisioning and template failures independently and retries safely", async () => {
    const id = randomUUID();
    const input = valid("retry");
    vi.mocked(provisionHospital).mockRejectedValueOnce(new Error("provisioning interrupted"));
    const install = vi.mocked(installDepartmentTemplate).getMockImplementation()!;
    let committedStatus: unknown;
    vi.mocked(installDepartmentTemplate).mockImplementationOnce(async (...args) => {
      const [row] = await queryClient`select template_status from hospital_onboardings where id = ${id}`;
      committedStatus = row?.template_status;
      await install(...args);
      throw new Error("template interrupted");
    });
    expect((await create(input, id)).statusCode).toBe(503);
    expect((await status(id)).json()).toMatchObject({ tenantId: null, provisioning: "failed", template: "none" });
    const created = await create(input, id);
    expect(created.statusCode).toBe(201);
    expect(committedStatus).toBe("pending");
    const { tenantId } = created.json();
    expect(created.json()).toMatchObject({ provisioning: "created", provisioningError: null, template: "failed" });
    expect(await queryClient`select 1 from departments where tenant_id = ${tenantId}`).toHaveLength(0);
    expect((await create(input, id)).json()).toMatchObject({ tenantId, template: "failed" });
    expect((await action(id, "activate")).statusCode).toBe(409);

    const retries = await Promise.all([action(id, "retry-template"), action(id, "retry-template")]);
    for (const retry of retries) expect(retry.json().hospital).toMatchObject({ tenantId, template: "installed" });
    expect(await queryClient`select 1 from departments where tenant_id = ${tenantId}`).toHaveLength(1);
    const events = await queryClient`select action, reason from platform_audit_log where onboarding_id = ${id}`;
    expect(events).toEqual(expect.arrayContaining([
      { action: "provisioning_failed", reason: "provisioning_failed" },
      { action: "template_failed", reason: "template_install_failed" },
    ]));
    expect(events.filter((event) => event.action === "template_installed")).toHaveLength(1);
  });

  it("expires invitations and invalidates old tokens on reissue", async () => {
    const created = await create(valid("expire", { department: "ENT / Rhinology" }));
    const { id } = created.json();
    const first = tokenFrom((await action(id, "invitation")).json().invitationPath);
    const second = tokenFrom((await action(id, "invitation")).json().invitationPath);
    expect((await accept(first)).statusCode).toBe(400);
    await queryClient`update hospital_onboardings set invitation_expires_at = now() - interval '1 second' where id = ${id}`;
    expect((await accept(second)).statusCode).toBe(400);
    expect((await status(id)).json().invitation).toBe("expired");
    const third = tokenFrom((await action(id, "invitation")).json().invitationPath);
    expect((await accept(third)).statusCode).toBe(200);
  });
});
