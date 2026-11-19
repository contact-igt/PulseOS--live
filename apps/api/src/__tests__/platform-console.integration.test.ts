import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { authorizeLastPlatformAdminRecovery, bootstrapPlatform, OPS, SUPER } from "../domain/platform/platform-auth.service.js";
import { processDueNotifications } from "../domain/notification/notification.service.js";
import { tenantCapabilityMap } from "../domain/capability/capability.service.js";
import { processHospitalInvitationDeliveries, type InvitationMail } from "../domain/tenant/hospital-invitation-delivery.service.js";

function totp(setupKey: string, offset = 0) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const binary = [...setupKey].map((letter) => alphabet.indexOf(letter).toString(2).padStart(5, "0")).join("");
  const secret = Buffer.from(binary.match(/.{8}/g)!.map((bits) => parseInt(bits, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const hmac = createHmac("sha1", secret).update(counter).digest();
  return String((hmac.readUInt32BE(hmac.at(-1)! & 15) & 0x7fffffff) % 1000000).padStart(6, "0");
}

describe.skipIf(process.env.PLATFORM_TEST_DATABASE !== "1")("platform browser authentication and management", () => {
  let app: FastifyInstance;
  const email = "platform-super@example.test";
  const operatorEmail = "platform-operations@example.test";
  const password = "Synthetic platform test password";
  const requestHeaders = { origin: "http://localhost:3310", "x-pulseos-platform": "1" };
  let adminId: string;
  let opsId: string;
  let superSession: string;
  let opsSession: string;
  let adminSecret: string;
  let opsSecret: string;
  let hospitalId: string | undefined;
  const send = (method: InjectOptions["method"], url: string, payload?: object, cookie?: string,
    headers: Record<string, string> = requestHeaders, remoteAddress?: string) =>
    app.inject({ method, url, ...(payload ? { payload } : {}), ...(remoteAddress ? { remoteAddress } : {}),
      headers: { ...headers, ...(cookie ? { cookie } : {}) } });
  const session = (value: string) => "pulseos_platform_session=" + value;
  const team = (cookie: string, email: string, role: string, permissions: string[] = []) =>
    send("POST", "/platform/administrators", { email, role, permissions }, cookie);
  const setup = async (setupToken: string, remoteAddress?: string) => {
    const start = await send("POST", "/platform/enroll", { invitation: setupToken, password }, undefined, requestHeaders, remoteAddress);
    expect(start.statusCode).toBe(200);
    const secret = start.json().setupKey;
    const challenge = start.cookies.find((cookie) => cookie.name === "pulseos_platform_enrollment")!;
    const challengeCookie = challenge.name + "=" + challenge.value;
    const actual = totp(secret);
    const valid = [-1, 0, 1, 2].map((offset) => totp(secret, offset));
    const incorrect = ["000000", "000001", "000002", "000003", "000004"].find((candidate) => !valid.includes(candidate));
    expect((await send("POST", "/platform/enroll/verify", { code: incorrect }, challengeCookie)).statusCode).toBe(401);
    const finish = await send("POST", "/platform/enroll/verify", { code: actual }, challengeCookie);
    expect(finish.statusCode).toBe(200);
    const cookie = finish.cookies.find((candidate) => candidate.name === "pulseos_platform_session")!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/platform", maxAge: 28800 });
    expect((await send("POST", "/platform/enroll/verify", { code: actual }, challengeCookie)).statusCode).toBe(401);
    return { cookie: session(cookie.value), secret };
  };

  beforeAll(async () => {
    const [database] = await queryClient`select current_database() as name`;
    expect(database?.name).toBe("pulseos_platform_test");
    expect(await queryClient`select id from platform_accounts limit 1`).toHaveLength(0);
    vi.stubEnv("PLATFORM_MFA_KEY", "c1".repeat(32));
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await app?.close();
    await queryClient.end();
  });

  it("bootstraps once under concurrency and verifies MFA before issuing a browser session", async () => {
    const actions = await Promise.all([bootstrapPlatform(db, email), bootstrapPlatform(db, email), bootstrapPlatform(db, "other@example.test")]);
    // The first two calls share an email. Whichever call wins, only one account and setup token exist.
    expect(actions.filter((row) => row.state === "created")).toHaveLength(1);
    const [account] = await queryClient`select id, email from platform_accounts`;
    adminId = account!.id;
    const initial = actions.find((row) => row.state === "created")!;
    expect(await bootstrapPlatform(db, String(account!.email))).toEqual({ state: "already_configured" });
    const renewal = await bootstrapPlatform(db, String(account!.email), true);
    expect(renewal.state).toBe("renewed");
    if (renewal.state !== "renewed" || initial.state !== "created") throw new Error("Bootstrap did not produce an invitation");
    expect((await send("POST", "/platform/enroll", { invitation: initial.setupToken, password })).statusCode).toBe(401);
    expect((await send("GET", "/platform/me")).statusCode).toBe(401);
    const result = await setup(renewal.setupToken);
    superSession = result.cookie;
    adminSecret = result.secret;
    expect((await send("GET", "/platform/me", undefined, superSession)).json()).toMatchObject({ id: adminId, email: account!.email, role: SUPER });
    expect(await bootstrapPlatform(db, String(account!.email), true)).toEqual({ state: "refused" });
    expect(await queryClient`select id from platform_accounts where mfa_secret = ${adminSecret}`).toHaveLength(0);
  });

  it("protects the last administrator, enforces Ops grants, and revokes sessions on changes", async () => {
    expect((await send("PATCH", "/platform/administrators/" + adminId, { role: OPS, permissions: [], disabled: true }, superSession)).json())
      .toEqual({ error: "last_super_admin" });
    const invited = await team(superSession, operatorEmail, OPS);
    expect(invited.statusCode).toBe(201);
    opsId = invited.json().id;
    expect((await team(superSession, operatorEmail.toUpperCase(), OPS)).statusCode).toBe(409);
    const operator = await setup(invited.json().setupToken);
    opsSession = operator.cookie;
    opsSecret = operator.secret;
    expect((await send("GET", "/platform/dashboard", undefined, opsSession)).json().recentAudit).toEqual([]);
    expect((await send("GET", "/platform/hospitals", undefined, opsSession)).statusCode).toBe(200);
    expect((await send("POST", "/platform/hospitals", {}, opsSession)).statusCode).toBe(403);
    expect((await team(opsSession, "elevated@example.test", SUPER)).statusCode).toBe(403);
    expect((await send("GET", "/platform/audit", undefined, opsSession)).statusCode).toBe(403);
    expect((await send("PATCH", "/platform/administrators/" + opsId, { role: OPS, permissions: ["hospital:create"], disabled: false }, superSession)).statusCode).toBe(200);
    expect((await send("GET", "/platform/me", undefined, opsSession)).statusCode).toBe(401);
    const code = totp(operator.secret, 1);
    const login = await send("POST", "/platform/login", { email: operatorEmail, password, code });
    expect(login.statusCode).toBe(200);
    opsSession = session(login.cookies.find((cookie) => cookie.name === "pulseos_platform_session")!.value);
    expect((await send("POST", "/platform/login", { email: operatorEmail, password, code })).statusCode).toBe(401);
    expect((await send("POST", "/platform/hospitals", {}, opsSession)).statusCode).toBe(400);
    expect((await send("POST", "/platform/hospitals/" + randomUUID() + "/activate", undefined, opsSession)).statusCode).toBe(403);
  });

  it("checks CSRF and the cookie boundary across the platform and hospital APIs", async () => {
    const login = await send("POST", "/auth/login", { email: "namokar.admin@pulseos.local", password: process.env.DEMO_PASSWORD });
    expect(login.statusCode).toBe(200);
    const hospitalCookie = login.cookies.find((cookie) => cookie.name === "pulseos_session")!;
    const hospitalSession = hospitalCookie.name + "=" + hospitalCookie.value;
    for (const [method, path] of [
      ["GET", "/platform/me"], ["GET", "/platform/dashboard"], ["GET", "/platform/hospitals"], ["GET", "/platform/hospitals/" + randomUUID()],
      ["GET", "/platform/hospitals/" + randomUUID() + "/archival-assessment"],
      ["GET", "/platform/administrators"], ["GET", "/platform/audit"], ["POST", "/platform/logout"], ["POST", "/platform/hospitals"],
      ["POST", "/platform/administrators/" + randomUUID() + "/recovery"],
      ["POST", "/platform/hospitals/" + randomUUID() + "/retry-template"], ["POST", "/platform/hospitals/" + randomUUID() + "/invitation"],
      ["POST", "/platform/hospitals/" + randomUUID() + "/invitation-resend"],
      ["POST", "/platform/hospitals/" + randomUUID() + "/activate"], ["POST", "/platform/administrators"],
      ["PATCH", "/platform/administrators/" + randomUUID()],
    ] as const) {
      expect((await send(method, path, undefined, hospitalSession)).statusCode).toBe(403);
    }
    expect((await send("GET", "/platform/me", undefined, superSession + "; " + hospitalSession)).statusCode).toBe(200);
    expect((await send("GET", "/patients", undefined, superSession)).statusCode).toBe(401);
    expect((await send("POST", "/platform/logout", undefined, superSession, {})).statusCode).toBe(403);
    expect((await send("POST", "/platform/logout", undefined, superSession, { origin: "https://foreign.example.test", "x-pulseos-platform": "1" })).statusCode).toBe(403);
    expect((await send("POST", "/platform/logout", undefined, superSession, { origin: requestHeaders.origin })).statusCode).toBe(403);
    expect((await send("GET", "/platform/me", undefined, superSession, { "sec-fetch-site": "same-site" })).statusCode).toBe(403);
    const preflight = await send("OPTIONS", "/platform/hospitals", undefined, undefined, {
      origin: requestHeaders.origin, "access-control-request-method": "POST",
      "access-control-request-headers": "content-type, idempotency-key, x-pulseos-platform",
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-headers"]).toContain("idempotency-key");
    expect((await send("POST", "/auth/signup", {})).statusCode).toBe(410);
  });

  it("reuses hospital onboarding with browser authorization and logs only metadata", async () => {
    const id = randomUUID();
    hospitalId = id;
    const body = {
      fullName: "Asha Platform", email: id + "@example.test", phone: "+91 98765 43210",
      organizationName: "Platform Browser Test", industry: "Healthcare", organizationType: "Eye Hospital",
      department: "Ophthalmology", addressLine: "123 Test Road", city: "Bengaluru", state: "Karnataka",
      pinCode: "560001", discoverySource: "Google",
    };
    const headers = { ...requestHeaders, "idempotency-key": id };
    expect((await send("POST", "/platform/hospitals", body, opsSession, headers)).statusCode).toBe(201);
    expect((await send("POST", "/platform/hospitals", body, opsSession, headers)).statusCode).toBe(200);
    expect((await send("POST", "/platform/hospitals", { ...body, city: "Changed" }, opsSession, headers)).statusCode).toBe(409);
    const detail = await send("GET", "/platform/hospitals/" + id, undefined, superSession);
    expect(detail.json()).toMatchObject({ name: body.organizationName, template: "installed", readinessFailures: ["invitation_acceptance_required"] });
    expect((await send("POST", "/platform/hospitals/" + id + "/activate", undefined, superSession)).statusCode).toBe(409);
    const invitation = await send("POST", "/platform/hospitals/" + id + "/invitation", undefined, superSession);
    expect(invitation.statusCode).toBe(200);
    const token = invitation.json().invitationPath.split("#")[1];
    const audit = await send("GET", "/platform/audit", undefined, superSession);
    expect(audit.payload).not.toContain(token);
    expect(audit.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ actorId: opsId, subjectId: id, action: "hospital_created" })]));
    expect((await send("GET", "/platform/hospitals?search=Platform+Browser", undefined, superSession)).json().items)
      .toEqual([expect.objectContaining({ onboardingId: id, name: body.organizationName })]);
    expect((await send("GET", "/platform/hospitals?page=101", undefined, superSession)).statusCode).toBe(400);
    expect((await send("GET", "/platform/dashboard", undefined, superSession)).json())
      .toMatchObject({ pending: expect.any(Number), pendingInvitations: expect.any(Number), recentAudit: expect.any(Array) });
  });

  it("queues confidential invitation email, retries the same token and audits authorized replacement", async () => {
    const previousKey = process.env.CONNECTOR_ENCRYPTION_KEY;
    const previousOrigin = process.env.HOSPITAL_INVITATION_WEB_ORIGIN;
    vi.stubEnv("HOSPITAL_INVITATION_EMAIL_ENABLED", "true");
    vi.stubEnv("CONNECTOR_ENCRYPTION_KEY", "synthetic-invitation-key");
    vi.stubEnv("HOSPITAL_INVITATION_WEB_ORIGIN", "");
    const id = randomUUID();
    const body = {
      fullName: "Invitation Test", email: id + "@example.test", phone: "+91 98765 43210",
      organizationName: "Mail Fixture " + id, industry: "Healthcare", organizationType: "Eye Hospital",
      department: "Ophthalmology", addressLine: "123 Test Road", city: "Bengaluru", state: "Karnataka",
      pinCode: "560001", discoverySource: "Google",
    };
    const url = "/platform/hospitals/" + id;
    const createHeaders = { ...requestHeaders, "idempotency-key": id };
    const read = async () => (await send("GET", url, undefined, superSession)).json();
    const resend = (key: string, cookie = superSession) =>
      send("POST", url + "/invitation-resend", undefined, cookie, { ...requestHeaders, "idempotency-key": key });
    const redeem = (token: string) => send("POST", "/auth/hospital-invitations/redeem", { token, password: "Synthetic invitation password" });
    const mails: InvitationMail[] = [];
    try {
      const created = await send("POST", "/platform/hospitals", body, opsSession, createHeaders);
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ invitation: "pending", invitationDelivery: { status: "pending", attempts: 0 } });
      expect((await send("POST", "/platform/hospitals", body, opsSession, createHeaders)).statusCode).toBe(200);
      await processHospitalInvitationDeliveries(db, new Date());
      expect(await read()).toMatchObject({ invitationDelivery: { failure: "mail_not_configured", attempts: 1 } });
      await processHospitalInvitationDeliveries(db, new Date(Date.now() + 300_000), async (mail) => {
        mails.push(mail);
        throw new Error("synthetic SMTP failure");
      });
      const next = new Date(Date.now() + 900_000);
      const accept = async (mail: InvitationMail) => { mails.push(mail); };
      await Promise.all([processHospitalInvitationDeliveries(db, next, accept), processHospitalInvitationDeliveries(db, next, accept)]);
      expect(mails).toHaveLength(2);
      expect(mails[1]).toMatchObject({ to: body.email, token: mails[0]!.token, messageId: mails[0]!.messageId });
      const accepted = await read();
      expect(accepted.invitationDelivery).toMatchObject({ status: "accepted", attempts: 3 });
      expect(JSON.stringify(accepted)).not.toContain(mails[0]!.token);
      expect((await resend(randomUUID(), opsSession)).statusCode).toBe(403);
      expect((await resend(randomUUID())).statusCode).toBe(429);
      await queryClient`update hospital_onboardings set invitation_expires_at=now()-interval '1 second' where id=${id}`;
      expect((await read()).invitation).toBe("expired");
      expect((await redeem(mails[0]!.token)).statusCode).toBe(400);
      await queryClient`update hospital_onboardings set invitation_expires_at=now()+interval '2 hours' where id=${id}`;
      const key = randomUUID();
      const duplicate = await Promise.all([resend(key), resend(key)]);
      expect(duplicate.map((result) => result.statusCode)).toEqual([202, 202]);
      expect(duplicate[0]!.json()).toEqual({ queued: true });
      await processHospitalInvitationDeliveries(db, new Date(), accept);
      expect(mails).toHaveLength(3);
      expect(mails[2]!.token).not.toBe(mails[0]!.token);
      expect((await redeem(mails[0]!.token)).statusCode).toBe(400);
      expect((await redeem(mails[2]!.token)).statusCode).toBe(200);
      expect((await redeem(mails[2]!.token)).statusCode).toBe(400);
      expect((await resend(randomUUID())).statusCode).toBe(409);
      const audit = await queryClient`select action, reason from platform_audit_log where onboarding_id=${id}`;
      expect(audit.map((entry) => entry.action)).toEqual(expect.arrayContaining([
        "invitation_resend_denied", "invitation_resend_queued", "invitation_resend_replayed", "invitation_email_accepted",
      ]));
      expect(JSON.stringify(audit)).not.toContain(mails[2]!.token);
    } finally {
      vi.stubEnv("HOSPITAL_INVITATION_EMAIL_ENABLED", "false");
      vi.stubEnv("CONNECTOR_ENCRYPTION_KEY", previousKey);
      vi.stubEnv("HOSPITAL_INVITATION_WEB_ORIGIN", previousOrigin);
    }
  });

  it("suspends a legacy hospital, holds intake and dispatch, and restores it with fresh login", async () => {
    const credentials = { email: "gyn.superadmin@pulseos.local", password: process.env.DEMO_PASSWORD };
    const login = await send("POST", "/auth/login", { ...credentials, remember: true });
    expect(login.statusCode).toBe(200);
    const { tenantId } = login.json().user;
    const hospitalCookie = "pulseos_session=" + login.cookies.find((cookie) => cookie.name === "pulseos_session")!.value;
    const path = "/platform/hospitals/" + tenantId + "/";
    const capabilities = await tenantCapabilityMap(db, tenantId);
    const [form] = await queryClient`select id from connectors where tenant_id = ${tenantId} and provider = 'website_form'`;
    const [patient] = await queryClient`select id from patients where tenant_id = ${tenantId} limit 1`;
    const notification = randomUUID();
    const receipt = randomUUID();
    const wamid = "wamid.lifecycle." + receipt;
    const [connector] = await queryClient`select id from connectors where tenant_id = ${tenantId} and provider = 'whatsapp_meta_cloud'`;
    const { getConnectorSecrets } = await import("../domain/connector/connector.service.js");
    const secrets = await getConnectorSecrets(db, connector!.id);
    await queryClient`insert into notifications (id, tenant_id, patient_id, subject_type, subject_id, scheduled_for, idempotency_key, status, provider_message_id)
      values (${notification}, ${tenantId}, ${patient!.id}, 'APPOINTMENT', ${notification}, now() - interval '2 hours', ${notification}, 'PENDING', null),
             (${receipt}, ${tenantId}, ${patient!.id}, 'APPOINTMENT', ${receipt}, now(), ${receipt}, 'SENT', ${wamid})`;
    const initial = await send("GET", path + "lifecycle?legacy=1", undefined, opsSession);
    expect(initial.json()).toMatchObject({ status: "ACTIVE", loginEnabled: true });
    const change = { version: initial.json().version, reason: "OPERATIONS" };
    expect((await send("POST", path + "suspend?legacy=1", change, opsSession)).statusCode).toBe(403);
    expect((await send("POST", path + "suspend?legacy=1", change, hospitalCookie)).statusCode).toBe(403);
    const responses = await Promise.all([
      send("POST", path + "suspend?legacy=1", change, superSession),
      send("POST", path + "suspend?legacy=1", change, superSession),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect((await send("POST", path + "restore?legacy=1", change, superSession)).statusCode).toBe(409);
    expect((await send("GET", "/patients", undefined, hospitalCookie)).statusCode).toBe(401);
    expect((await send("POST", "/auth/login", credentials)).statusCode).toBe(401);
    expect((await send("POST", "/forms/website/" + form!.id, { submissionId: notification, formId: "fixture", name: "Synthetic Intake", phone: "+919876543210" })).statusCode).toBe(503);
    await processDueNotifications(db, new Date(), { adapterFor: () => null });
    const [queued] = await queryClient`select status, attempts from notifications where id = ${notification}`;
    expect(queued).toMatchObject({ status: "PENDING", attempts: 0 });

    const raw = JSON.stringify({ entry: [{ changes: [{ field: "messages", value: {
      statuses: [{ id: wamid, status: "delivered", timestamp: String(Math.floor(Date.now() / 1000)) }],
    } }] }] });
    const signature = "sha256=" + createHmac("sha256", String(secrets?.appSecret)).update(raw).digest("hex");
    const callback = await app.inject({ method: "POST", url: "/webhooks/whatsapp/" + connector!.id, payload: raw,
      headers: { "content-type": "application/json", "x-hub-signature-256": signature } });
    expect(callback.statusCode).toBe(200);
    const [delivered] = await queryClient`select status from notifications where id = ${receipt}`;
    expect(delivered?.status).toBe("DELIVERED");

    const assessmentPath = path + "archival-assessment?legacy=1";
    expect((await send("GET", assessmentPath, undefined, opsSession)).statusCode).toBe(403);
    expect((await send("GET", assessmentPath, undefined, superSession, { origin: "https://foreign.example.test" })).statusCode).toBe(403);
    expect((await send("GET", path + "archival-assessment", undefined, superSession)).statusCode).toBe(404);
    expect((await send("POST", assessmentPath, {}, superSession)).statusCode).toBe(404);
    const assessment = await send("GET", assessmentPath, undefined, superSession);
    expect(assessment.statusCode).toBe(200);
    expect(assessment.headers["cache-control"]).toBe("no-store");
    expect(assessment.json()).toMatchObject({ lifecycle: { state: "SUSPENDED", version: change.version + 1 },
      evidence: { pendingNotifications: expect.any(Number) }, findings: expect.arrayContaining([
        expect.objectContaining({ classification: "BLOCKED_BY_OPEN_WORK", basis: "record" }),
        expect.objectContaining({ classification: "POLICY_NOT_APPROVED", basis: "policy" }),
        expect.objectContaining({ classification: "EVIDENCE_UNAVAILABLE" }),
      ]) });
    expect(assessment.json().evidence.pendingNotifications).toBeGreaterThan(0);
    expect(assessment.body).not.toContain(wamid);
    expect(assessment.body).not.toContain(patient!.id);
    expect(assessment.body).not.toContain("BLOCKED_BY_STATE");
    const otherAssessment = await send("GET", "/platform/hospitals/" + hospitalId + "/archival-assessment", undefined, superSession);
    expect(otherAssessment.statusCode).toBe(200);
    expect(otherAssessment.json().evidence.pendingNotifications).toBe(0);
    const [stillQueued] = await queryClient`select status, attempts from notifications where id = ${notification}`;
    expect(stillQueued).toMatchObject({ status: "PENDING", attempts: 0 });

    const restore = await send("POST", path + "restore?legacy=1", { version: change.version + 1, reason: "SERVICE_RESTORED" }, superSession);
    expect(restore.json()).toMatchObject({ lifecycle: { status: "ACTIVE", loginEnabled: true } });
    expect((await send("GET", assessmentPath, undefined, superSession)).json().findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ classification: "BLOCKED_BY_STATE", basis: "policy" }),
    ]));
    expect((await send("GET", "/patients", undefined, hospitalCookie)).statusCode).toBe(401);
    expect((await send("POST", "/auth/login", credentials)).statusCode).toBe(200);
    expect(await tenantCapabilityMap(db, tenantId)).toEqual(capabilities);
    const [overdue] = await queryClient`select status, reason from notifications where id = ${notification}`;
    expect(overdue).toEqual({ status: "BLOCKED", reason: "LIFECYCLE_STALE_NOTIFICATION" });
    const history = await send("GET", path + "lifecycle-history?legacy=1", undefined, opsSession);
    expect(history.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: adminId, previousState: "ACTIVE", requestedState: "SUSPENDED", outcome: "applied", reason: "OPERATIONS" }),
      expect.objectContaining({ actorId: adminId, previousState: "SUSPENDED", requestedState: "ACTIVE", outcome: "applied" }),
      expect.objectContaining({ actorId: opsId, outcome: "forbidden" }),
    ]));
  });

  it("approves MFA recovery with fresh MFA, revokes the old session, and requires the current password and a new authenticator", async () => {
    const path = "/platform/administrators/" + opsId + "/recovery";
    const manage = (payload: object, cookie = superSession) => send("POST", path, payload, cookie);
    const [prior] = await queryClient`select last_mfa_step from platform_accounts where id=${adminId}`;
    const invitation = await team(superSession, "recovery-reviewer@example.test", SUPER);
    expect(invitation.statusCode).toBe(201);
    const reviewerId = invitation.json().id;
    const reviewer = await setup(invitation.json().setupToken, "192.0.2.42");
    try {
      expect((await manage({ action: "request" }, opsSession)).statusCode).toBe(403);
      expect((await send("POST", "/platform/administrators/" + adminId + "/recovery", { action: "request" }, superSession)).statusCode).toBe(403);
      const requests = await Promise.all([manage({ action: "request" }), manage({ action: "request" })]);
      expect(requests.map((result) => result.statusCode).sort()).toEqual([200, 409]);
      expect((await manage({ action: "reject" })).statusCode).toBe(200);
      expect((await manage({ action: "request" })).statusCode).toBe(200);
      expect((await send("PATCH", "/platform/administrators/" + opsId, { role: OPS, permissions: [], disabled: true }, superSession)).statusCode).toBe(200);
      expect((await manage({ action: "request" })).statusCode).toBe(409);
      expect((await send("PATCH", "/platform/administrators/" + opsId, { role: OPS, permissions: [], disabled: false }, superSession)).statusCode).toBe(200);
      expect((await manage({ action: "request" })).statusCode).toBe(200);
      expect((await send("PATCH", "/platform/administrators/" + opsId, { role: SUPER, permissions: [], disabled: false }, superSession)).statusCode).toBe(200);
      expect((await manage({ action: "approve", code: totp(adminSecret) })).statusCode).toBe(409);
      expect((await send("PATCH", "/platform/administrators/" + opsId, { role: OPS, permissions: [], disabled: false }, superSession)).statusCode).toBe(200);
      expect((await manage({ action: "request" })).statusCode).toBe(200);
      await queryClient`update platform_accounts set last_mfa_step=${Math.floor(Date.now() / 30_000) - 1} where id=${opsId}`;
      const login = await send("POST", "/platform/login", { email: operatorEmail, password, code: totp(opsSecret) });
      expect(login.statusCode).toBe(200);
      const oldSession = session(login.cookies.find((cookie) => cookie.name === "pulseos_platform_session")!.value);
      expect((await manage({ action: "approve", code: totp(adminSecret, 1) })).statusCode).toBe(403);
      expect((await manage({ action: "approve", code: totp(opsSecret, 1) }, oldSession)).statusCode).toBe(403);
      const [pending] = await queryClient`update platform_mfa_recoveries set requested_by=null where account_id=${opsId} returning status`;
      expect(pending?.status).toBe("pending");
      expect((await manage({ action: "approve", code: totp(reviewer.secret, 1) }, reviewer.cookie)).statusCode).toBe(409);
      expect((await manage({ action: "reject" })).statusCode).toBe(200);
      expect((await manage({ action: "request" })).statusCode).toBe(200);
      await queryClient`update platform_accounts set last_mfa_step=${Math.floor(Date.now() / 30_000)} where id=${reviewerId}`;
      expect((await manage({ action: "approve", code: totp(reviewer.secret) }, reviewer.cookie)).statusCode).toBe(401);
      const approval = await manage({ action: "approve", code: totp(reviewer.secret, 1) }, reviewer.cookie);
      expect(approval.statusCode).toBe(200);
      expect(approval.headers["cache-control"]).toBe("no-store");
      const { recoveryToken, expiresAt } = approval.json();
      expect((await send("GET", "/platform/me", undefined, oldSession)).statusCode).toBe(401);
      expect((await send("POST", "/platform/login", { email: operatorEmail, password, code: totp(opsSecret) })).statusCode).toBe(401);
      expect((await send("POST", "/platform/enroll", { invitation: recoveryToken, password: "Incorrect synthetic password" })).statusCode).toBe(401);
      await queryClient`update platform_mfa_recoveries set expires_at=now()-interval '1 second' where account_id=${opsId}`;
      expect((await send("POST", "/platform/enroll", { invitation: recoveryToken, password })).statusCode).toBe(401);
      await queryClient`update platform_mfa_recoveries set expires_at=${expiresAt} where account_id=${opsId}`;
      const recovered = await setup(recoveryToken, "192.0.2.40");
      opsSession = recovered.cookie;
      expect((await send("GET", "/platform/me", undefined, opsSession)).json()).toMatchObject({ id: opsId, role: OPS });
      expect((await send("POST", "/platform/enroll", { invitation: recoveryToken, password }, undefined, requestHeaders, "192.0.2.40")).statusCode).toBe(401);
      const members = await send("GET", "/platform/administrators", undefined, superSession);
      expect(members.payload).not.toContain(recoveryToken);
      expect(members.json().items).toContainEqual(expect.objectContaining({ id: opsId, recovery: expect.objectContaining({ status: "completed" }) }));
      const history = await send("GET", path, undefined, superSession);
      expect(history.json().items).toContainEqual(expect.objectContaining({ action: "mfa_recovery_completed" }));
    } finally {
      await queryClient`update platform_accounts set last_mfa_step=${prior!.last_mfa_step} where id=${adminId}`;
      await queryClient`update platform_accounts set disabled_at=now() where id=${reviewerId}`;
    }
  });

  it("expires idle and absolute sessions and revokes logout server-side", async () => {
    const [administrator] = await queryClient`select email from platform_accounts where id = ${adminId}`;
    const login = async (offset: number) => {
      const result = await send("POST", "/platform/login", { email: administrator!.email, password, code: totp(adminSecret, offset) });
      expect(result.statusCode).toBe(200);
      return session(result.cookies.find((candidate) => candidate.name === "pulseos_platform_session")!.value);
    };
    const absoluteSession = await login(1);
    const { digest } = await import("../domain/tenant/hospital-onboarding.service.js");
    const hash = (cookie: string) => digest(cookie.split("=")[1]!);
    await queryClient`update platform_sessions set expires_at = now() - interval '1 second' where token_hash = ${hash(absoluteSession)}`;
    expect((await send("GET", "/platform/me", undefined, absoluteSession)).statusCode).toBe(401);
    await queryClient`update platform_sessions set last_seen_at = now() - interval '31 minutes' where token_hash = ${hash(opsSession)}`;
    expect((await send("GET", "/platform/me", undefined, opsSession)).statusCode).toBe(401);
    await queryClient`update platform_sessions set last_seen_at = now() where token_hash = ${hash(opsSession)}`;
    expect((await send("GET", "/platform/me", undefined, opsSession)).statusCode).toBe(200);
    expect((await send("PATCH", "/platform/administrators/" + opsId, { role: SUPER, permissions: [], disabled: false }, superSession)).statusCode).toBe(200);
    expect((await send("GET", "/platform/me", undefined, opsSession)).statusCode).toBe(401);
    expect((await send("POST", "/platform/logout", undefined, superSession)).statusCode).toBe(200);
    expect((await send("GET", "/platform/me", undefined, superSession)).statusCode).toBe(401);
    if (hospitalId) expect(await queryClient`select id from hospital_onboardings where id = ${hospitalId}`).toHaveLength(1);
  });

  it("routes last-admin recovery through privileged incident authorization only", async () => {
    expect(Boolean(await authorizeLastPlatformAdminRecovery(db, adminId, "INC-SYNTHETIC"))).toBe(false);
    await queryClient`update platform_accounts set disabled_at=now() where id=${opsId}`;
    expect(await authorizeLastPlatformAdminRecovery(db, adminId, "invalid")).toBeNull();
    const approved = await authorizeLastPlatformAdminRecovery(db, adminId, "INC-SYNTHETIC");
    expect(Boolean(approved)).toBe(true);
    expect(Boolean(await authorizeLastPlatformAdminRecovery(db, adminId, "INC-SYNTHETIC"))).toBe(false);
    const recovered = await setup(approved!.recoveryToken, "192.0.2.41");
    expect((await send("GET", "/platform/me", undefined, recovered.cookie)).json()).toMatchObject({ id: adminId, role: SUPER });
  });
});
