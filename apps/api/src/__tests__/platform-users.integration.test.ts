import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { accountTokens, platformAuditEvents, platformUsers, sessions, users } from "../db/schema.js";
import { localOutbox } from "../domain/platform/email.js";
import { createTestTenant, type TestTenant } from "./helpers/edition-tenant.js";
import { asPlatform, createPlatformUser, type TestPlatformUser } from "./helpers/platform.js";

const PASSWORD = "platform-test-password-1";
const NEW_PASSWORD = "a-brand-new-password-9";

/** The link the local outbox "sent" to this address (development only), and the token inside its fragment. */
function lastTokenFor(email: string): string {
  const msg = localOutbox()!.messages.find((m) => m.to === email);
  if (!msg) throw new Error(`no message for ${email}`);
  return /#token=([A-Za-z0-9_-]+)/.exec(msg.text)![1]!;
}

describe("platform users, memberships, invitations and sessions (integration)", () => {
  let app: FastifyInstance;
  let owner: TestPlatformUser;
  let admin: TestPlatformUser;
  let implementation: TestPlatformUser;
  let support: TestPlatformUser;
  let auditor: TestPlatformUser;
  let tA: TestTenant;
  let tB: TestTenant;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    owner = await createPlatformUser(db, app, "PLATFORM_OWNER", PASSWORD);
    admin = await createPlatformUser(db, app, "PLATFORM_ADMIN", PASSWORD);
    implementation = await createPlatformUser(db, app, "IMPLEMENTATION_ADMIN", PASSWORD);
    support = await createPlatformUser(db, app, "SUPPORT_AGENT", PASSWORD);
    auditor = await createPlatformUser(db, app, "PLATFORM_AUDITOR", PASSWORD);
    tA = await createTestTenant(db, app, "BETA_V2_GROWTH", PASSWORD);
    tB = await createTestTenant(db, app, "BETA_V1_CORE", PASSWORD);
  });

  afterAll(async () => {
    await app.close();
    await queryClient.end();
  });

  const inject = (u: TestPlatformUser, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) => app.inject({ method, url, cookies: asPlatform(u.cookie), ...(payload ? { payload } : {}) });

  it("invite -> accept -> sign in, with a single-use hashed token that is never returned", async () => {
    const email = `invitee.${randomUUID().slice(0, 8)}@platform-users-test.local`;
    const res = await inject(implementation, "POST", `/platform/tenants/${tA.tenantId}/members`, { name: "Ira Invitee", email, role: "FRONT_DESK" });
    expect(res.statusCode).toBe(201);
    expect(JSON.stringify(res.json())).not.toMatch(/token|password/i);
    const [account] = await db.select().from(users).where(eq(users.email, email));
    expect(account).toMatchObject({ status: "INVITED", passwordHash: null, role: "FRONT_DESK" });

    // An invited account cannot sign in.
    expect((await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: NEW_PASSWORD } })).statusCode).toBe(401);

    const token = lastTokenFor(email);
    const [row] = await db.select().from(accountTokens).where(eq(accountTokens.userId, account!.id));
    expect(row!.tokenHash).not.toContain(token);

    const inspect = await app.inject({ method: "POST", url: "/auth/account-token/inspect", payload: { token } });
    expect(inspect.statusCode).toBe(200);
    expect(inspect.json()).toMatchObject({ purpose: "INVITE", email });

    const weak = await app.inject({ method: "POST", url: "/auth/account-token/accept", payload: { token, password: "short" } });
    expect(weak.statusCode).toBe(400);
    const accept = await app.inject({ method: "POST", url: "/auth/account-token/accept", payload: { token, password: NEW_PASSWORD } });
    expect(accept.statusCode).toBe(200);
    const again = await app.inject({ method: "POST", url: "/auth/account-token/accept", payload: { token, password: NEW_PASSWORD } });
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toBe("invalid_token");

    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: NEW_PASSWORD } });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.tenantId).toBe(tA.tenantId);
  });

  it("an expired or revoked invitation cannot be used; resend issues a fresh link", async () => {
    const email = `exp.${randomUUID().slice(0, 8)}@platform-users-test.local`;
    const created = await inject(owner, "POST", `/platform/tenants/${tA.tenantId}/members`, { name: "Eli Expired", email, role: "DOCTOR" });
    const invitationId = created.json().invitation.id;
    const oldToken = lastTokenFor(email);
    await db.execute(`update account_tokens set expires_at = now() - interval '1 minute' where id = '${invitationId}'`);
    expect((await app.inject({ method: "POST", url: "/auth/account-token/inspect", payload: { token: oldToken } })).statusCode).toBe(404);

    const list = await inject(auditor, "GET", `/platform/invitations?status=expired&q=${encodeURIComponent(email)}`);
    expect(list.json().rows[0]).toMatchObject({ email, status: "EXPIRED" });
    expect(JSON.stringify(list.json())).not.toMatch(/token_?hash|tokenHash/);

    expect((await inject(auditor, "POST", `/platform/invitations/${invitationId}/resend`)).statusCode).toBe(403);
    const resent = await inject(support, "POST", `/platform/invitations/${invitationId}/resend`);
    expect(resent.statusCode).toBe(200);
    const fresh = lastTokenFor(email);
    expect(fresh).not.toBe(oldToken);
    const newId = resent.json().invitation.id;

    const revoke = await inject(support, "POST", `/platform/invitations/${newId}/revoke`, { reason: "Wrong person" });
    expect(revoke.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/auth/account-token/accept", payload: { token: fresh, password: NEW_PASSWORD } })).statusCode).toBe(400);
  });

  it("a person can belong to several hospitals; removing one membership keeps the person and the other membership", async () => {
    const email = `multi.${randomUUID().slice(0, 8)}@platform-users-test.local`;
    for (const t of [tA, tB]) {
      await inject(owner, "POST", `/platform/tenants/${t.tenantId}/members`, { name: "Mira Multi", email, role: "PATIENT_COORDINATOR" });
      const token = lastTokenFor(email);
      await app.inject({ method: "POST", url: "/auth/account-token/accept", payload: { token, password: NEW_PASSWORD } });
    }
    const dir = await inject(auditor, "GET", `/platform/users?q=${encodeURIComponent(email)}`);
    const row = dir.json().rows[0];
    expect(row.memberships).toHaveLength(2);
    const inA = row.memberships.find((m: { tenantId: string }) => m.tenantId === tA.tenantId);

    const removed = await inject(admin, "POST", `/platform/memberships/${inA.userId}/remove`, { reason: "Left this hospital" });
    expect(removed.statusCode).toBe(200);
    const accounts = await db.select().from(users).where(eq(users.email, email));
    expect(accounts).toHaveLength(2);
    expect(accounts.find((a) => a.tenantId === tA.tenantId)!.status).toBe("REMOVED");
    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: NEW_PASSWORD } });
    expect(login.statusCode).toBe(200);
    expect(login.json().user.tenantId).toBe(tB.tenantId);
    const branded = await app.inject({ method: "POST", url: `/auth/login`, payload: { email, password: NEW_PASSWORD } });
    expect(branded.json().user.tenantId).toBe(tB.tenantId);
  });

  it("a role change takes effect on the very next request", async () => {
    const res = await app.inject({ method: "GET", url: "/dashboard/executive", cookies: { pulseos_session: tA.cookie.FRONT_DESK! } });
    expect(res.statusCode).toBe(403);
    const [fd] = await db.select().from(users).where(eq(users.id, tA.userIds.FRONT_DESK!));
    const change = await inject(implementation, "PATCH", `/platform/memberships/${fd!.id}`, { role: "HOSPITAL_ADMIN", version: fd!.version });
    expect(change.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: "/dashboard/executive", cookies: { pulseos_session: tA.cookie.FRONT_DESK! } });
    expect(after.statusCode).toBe(200);
    const stale = await inject(implementation, "PATCH", `/platform/memberships/${fd!.id}`, { role: "FRONT_DESK", version: fd!.version });
    expect(stale.statusCode).toBe(409);
  });

  it("never leaves an active hospital without an administrator unless explicitly confirmed", async () => {
    const t = await createTestTenant(db, app, "BETA_V1_CORE", PASSWORD);
    const sa = t.userIds.SUPER_ADMIN!;
    const ha = t.userIds.HOSPITAL_ADMIN!;
    expect((await inject(admin, "POST", `/platform/memberships/${sa}/suspend`, { reason: "Investigating access" })).statusCode).toBe(200);
    const last = await inject(admin, "POST", `/platform/memberships/${ha}/suspend`, { reason: "Investigating access" });
    expect(last.statusCode).toBe(409);
    expect(last.json().error).toBe("last_tenant_admin");
    const confirmed = await inject(admin, "POST", `/platform/memberships/${ha}/suspend`, { reason: "Investigating access", confirmNoAdmin: true });
    expect(confirmed.statusCode).toBe(200);
    // A suspended membership is signed out at once.
    expect((await app.inject({ method: "GET", url: "/auth/session", cookies: { pulseos_session: t.cookie.HOSPITAL_ADMIN! } })).statusCode).toBe(401);
    const re = await inject(admin, "POST", `/platform/memberships/${ha}/reactivate`, { reason: "Cleared" });
    expect(re.statusCode).toBe(200);
  });

  it("password reset is sent as a link (never a visible password) and ends the account's sessions when used", async () => {
    const t = await createTestTenant(db, app, "BETA_V1_CORE", PASSWORD);
    const uid = t.userIds.DOCTOR!;
    const [u] = await db.select().from(users).where(eq(users.id, uid));
    const res = await inject(support, "POST", `/platform/memberships/${uid}/password-reset`);
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toMatch(/token|password"/i);
    const token = lastTokenFor(u!.email);
    expect((await app.inject({ method: "POST", url: "/auth/account-token/inspect", payload: { token } })).json().purpose).toBe("PASSWORD_RESET");
    await app.inject({ method: "POST", url: "/auth/account-token/accept", payload: { token, password: NEW_PASSWORD } });
    expect((await app.inject({ method: "GET", url: "/auth/session", cookies: { pulseos_session: t.cookie.DOCTOR! } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/auth/login", payload: { email: u!.email, password: PASSWORD } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/auth/login", payload: { email: u!.email, password: NEW_PASSWORD } })).statusCode).toBe(200);
  });

  it("user detail lists memberships and sessions with device metadata; sessions can be revoked one by one or all at once", async () => {
    const t = await createTestTenant(db, app, "BETA_V2_GROWTH", PASSWORD);
    const uid = t.userIds.PATIENT_COORDINATOR!;
    const detail = await inject(support, "GET", `/platform/users/${uid}`);
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.memberships[0]).toMatchObject({ tenantId: t.tenantId, role: "PATIENT_COORDINATOR", status: "ACTIVE" });
    expect(body.sessions.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(body)).not.toMatch(/passwordHash|password_hash|tokenHash/);
    const sessionId = body.sessions[0].id;
    const one = await inject(support, "DELETE", `/platform/sessions/${sessionId}`);
    expect(one.statusCode).toBe(200);
    expect(await db.select().from(sessions).where(eq(sessions.id, sessionId))).toHaveLength(0);
    const all = await inject(support, "POST", `/platform/memberships/${uid}/revoke-sessions`);
    expect(all.statusCode).toBe(200);
    const audit = await db.select().from(platformAuditEvents).where(and(eq(platformAuditEvents.targetId, uid), eq(platformAuditEvents.action, "sessions.revoked_all")));
    expect(audit).toHaveLength(1);
    expect((await inject(auditor, "POST", `/platform/memberships/${uid}/revoke-sessions`)).statusCode).toBe(403);
  });

  it("suspending a person suspends every membership and blocks sign-in, without deleting anything", async () => {
    const t = await createTestTenant(db, app, "BETA_V1_CORE", PASSWORD);
    const uid = t.userIds.FRONT_DESK!;
    const [u] = await db.select().from(users).where(eq(users.id, uid));
    expect((await inject(implementation, "POST", `/platform/users/${uid}/suspend`, { reason: "Lost device" })).statusCode).toBe(403);
    const res = await inject(admin, "POST", `/platform/users/${uid}/suspend`, { reason: "Lost device" });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/auth/login", payload: { email: u!.email, password: PASSWORD } })).statusCode).toBe(401);
    expect(await db.select().from(users).where(eq(users.id, uid))).toHaveLength(1);
    expect((await inject(admin, "POST", `/platform/users/${uid}/reactivate`, { reason: "Device found" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/auth/login", payload: { email: u!.email, password: PASSWORD } })).statusCode).toBe(200);
  });

  it("the global directory searches and filters on the server, and a tenant admin cannot call it", async () => {
    const res = await inject(auditor, "GET", `/platform/users?tenantId=${tB.tenantId}&role=DOCTOR&pageSize=5`);
    expect(res.statusCode).toBe(200);
    expect(res.json().rows.length).toBeGreaterThanOrEqual(1);
    expect(res.json().rows.every((r: { memberships: { tenantId: string; role: string }[] }) => r.memberships.some((m) => m.tenantId === tB.tenantId && m.role === "DOCTOR"))).toBe(true);
    const staff = await inject(auditor, "GET", `/platform/users?kind=staff&q=${encodeURIComponent(owner.email)}`);
    expect(staff.json().rows[0].platform).toMatchObject({ role: "PLATFORM_OWNER" });
    expect((await app.inject({ method: "GET", url: "/platform/users", cookies: { pulseos_session: tA.cookie.SUPER_ADMIN! } })).statusCode).toBe(401);
    expect((await inject(owner, "GET", `/platform/users/${randomUUID()}`)).statusCode).toBe(404);
  });

  describe("platform staff", () => {
    it("only a Platform Owner grants top roles; nobody changes their own access", async () => {
      const email = `staff.${randomUUID().slice(0, 8)}@platform-test.local`;
      expect((await inject(admin, "POST", "/platform/staff", { name: "Top Hopeful", email, role: "PLATFORM_OWNER" })).statusCode).toBe(403);
      expect((await inject(implementation, "POST", "/platform/staff", { name: "Sup Hopeful", email, role: "SUPPORT_AGENT" })).statusCode).toBe(403);
      const ok = await inject(admin, "POST", "/platform/staff", { name: "New Support", email, role: "SUPPORT_AGENT" });
      expect(ok.statusCode).toBe(201);
      const [p] = await db.select().from(platformUsers).where(eq(platformUsers.email, email));
      expect(p).toMatchObject({ status: "INVITED", passwordHash: null });
      expect((await inject(admin, "PATCH", `/platform/staff/${p!.id}`, { role: "PLATFORM_ADMIN", version: p!.version })).statusCode).toBe(403);
      const [me] = await db.select().from(platformUsers).where(eq(platformUsers.id, admin.id));
      const self = await inject(admin, "PATCH", `/platform/staff/${admin.id}`, { role: "SUPPORT_AGENT", version: me!.version });
      expect(self.statusCode).toBe(409);
      expect(self.json().error).toBe("self_change");
      // Platform invitation -> platform sign-in.
      await app.inject({ method: "POST", url: "/auth/account-token/accept", payload: { token: lastTokenFor(email), password: NEW_PASSWORD } });
      expect((await app.inject({ method: "POST", url: "/platform/auth/login", payload: { email, password: NEW_PASSWORD } })).statusCode).toBe(200);
    });

    it("the last active Platform Owner can never be removed, even by two owners suspending each other at once", async () => {
      const a = await createPlatformUser(db, app, "PLATFORM_OWNER", PASSWORD);
      const b = await createPlatformUser(db, app, "PLATFORM_OWNER", PASSWORD);
      const others = await db.select({ id: platformUsers.id }).from(platformUsers).where(and(eq(platformUsers.role, "PLATFORM_OWNER"), eq(platformUsers.status, "ACTIVE")));
      const restore = others.filter((o) => o.id !== a.id && o.id !== b.id).map((o) => o.id);
      try {
        // Only a and b are active owners now.
        for (const id of restore) await db.update(platformUsers).set({ status: "SUSPENDED" }).where(eq(platformUsers.id, id));
        const [ra, rb] = await Promise.all([
          inject(a, "POST", `/platform/staff/${b.id}/suspend`, { reason: "Race to suspend b" }),
          inject(b, "POST", `/platform/staff/${a.id}/suspend`, { reason: "Race to suspend a" }),
        ]);
        expect([ra.statusCode, rb.statusCode].filter((c) => c === 200)).toHaveLength(1);
        const active = await db.select().from(platformUsers).where(and(eq(platformUsers.role, "PLATFORM_OWNER"), eq(platformUsers.status, "ACTIVE")));
        expect(active).toHaveLength(1);
        // And the survivor cannot remove or demote themself.
        const survivor = active[0]!.id === a.id ? a : b;
        expect((await inject(survivor, "POST", `/platform/staff/${survivor.id}/suspend`, { reason: "Locking everyone out" })).statusCode).toBe(409);
        expect((await inject(survivor, "PATCH", `/platform/staff/${survivor.id}`, { role: "PLATFORM_ADMIN", version: active[0]!.version })).statusCode).toBe(409);
      } finally {
        for (const id of restore) await db.update(platformUsers).set({ status: "ACTIVE" }).where(eq(platformUsers.id, id));
      }
    });

    it("an owner can suspend another owner when one stays active, which signs them out", async () => {
      const target = await createPlatformUser(db, app, "PLATFORM_OWNER", PASSWORD);
      const res = await inject(owner, "POST", `/platform/staff/${target.id}/suspend`, { reason: "Left the company" });
      expect(res.statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/platform/auth/session", cookies: asPlatform(target.cookie) })).statusCode).toBe(401);
    });
  });
});
