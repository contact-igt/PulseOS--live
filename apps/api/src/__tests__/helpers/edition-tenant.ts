import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ConnectorMode, Edition, Role } from "@pulseos/types";
import type { Db } from "../../db/client.js";
import { branches, calls, connectorSecrets, connectors, patients, tenants, users } from "../../db/schema.js";
import { encryptSecret } from "../../domain/security/encryption.js";
import { hashPassword } from "../../domain/auth/auth.service.js";
import { purgePatientData } from "./purge.js";

export interface TestTenant {
  tenantId: string;
  branchId: string;
  edition: Edition;
  /** session cookie by role */
  cookie: Partial<Record<Role, string>>;
  userIds: Partial<Record<Role, string>>;
  connectorId: string;
  patientId: string;
  callId: string;
  recordingUrl: string;
}

const ROLES: { role: Role; slug: string }[] = [
  { role: "SUPER_ADMIN", slug: "superadmin" },
  { role: "HOSPITAL_ADMIN", slug: "admin" },
  { role: "FRONT_DESK", slug: "frontdesk" },
  { role: "PATIENT_COORDINATOR", slug: "coordinator" },
  { role: "DOCTOR", slug: "doctor" },
];

/**
 * A throwaway tenant with one user per role, one telephony connector and one recorded call — isolated from the
 * seeded demo tenants so edition/permission tests can assert on exactly the data they created.
 */
export async function createTestTenant(db: Db, app: FastifyInstance, edition: Edition, password: string, opts: { connectorMode?: ConnectorMode; webhookSecret?: string } = {}): Promise<TestTenant> {
  const tag = randomUUID().slice(0, 8);
  const [tenant] = await db.insert(tenants).values({ name: `Edition Test ${edition} ${tag}`, edition }).returning();
  const [branch] = await db.insert(branches).values({ tenantId: tenant.id, name: "Test Branch", city: "Bengaluru" }).returning();
  const passwordHash = await hashPassword(password);
  const cookie: TestTenant["cookie"] = {};
  const userIds: TestTenant["userIds"] = {};
  for (const { role, slug } of ROLES) {
    const email = `${slug}.${tag}@edition-test.local`;
    const [u] = await db.insert(users).values({ tenantId: tenant.id, branchId: branch.id, name: `${slug} ${tag}`, email, passwordHash, role }).returning({ id: users.id });
    userIds[role] = u!.id;
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
    cookie[role] = res.cookies.find((c) => c.name === "pulseos_session")!.value;
  }
  const [connector] = await db
    .insert(connectors)
    .values({ tenantId: tenant.id, type: "TELEPHONY", provider: "runo", displayName: "Test telephony", capabilities: ["RECEIVE_CALL_EVENT", "RECEIVE_RECORDING"], configuration: { accountRef: "test" }, ...(opts.connectorMode ? { mode: opts.connectorMode } : {}) })
    .returning();
  if (opts.webhookSecret) await db.insert(connectorSecrets).values({ connectorId: connector.id, encryptedPayload: encryptSecret({ webhookSharedSecret: opts.webhookSecret }) });
  const [patient] = await db.insert(patients).values({ tenantId: tenant.id, name: `Patient ${tag}`, phone: "+91 90000 00000", phoneE164: `+9190${Math.floor(10000000 + Math.random() * 89999999)}` }).returning();
  // A fixture recording: playable (silent) and unique per tenant, so a leak of the stored reference is detectable.
  const recordingUrl = `pulseos-fixture://silence.wav?${tag}`;
  const [call] = await db
    .insert(calls)
    .values({ tenantId: tenant.id, connectorId: connector.id, patientId: patient.id, externalCallId: `ext-${tag}`, direction: "inbound", phone: patient.phone, status: "completed", durationSeconds: 61, recordingUrl })
    .returning();
  return { tenantId: tenant.id, branchId: branch.id, edition, cookie, userIds, connectorId: connector.id, patientId: patient.id, callId: call.id, recordingUrl };
}

/** Removes everything a throwaway tenant owns, in foreign-key order — whatever the test added to it. */
export async function destroyTestTenant(db: Db, t: TestTenant): Promise<void> {
  const patientIds = (await db.select({ id: patients.id }).from(patients).where(eq(patients.tenantId, t.tenantId))).map((p) => p.id);
  await purgePatientData(db, patientIds);
  const tenant = sql`${t.tenantId}::uuid`;
  const statements = [
    sql`delete from tenant_capabilities where tenant_id = ${tenant}`,
    sql`delete from tenant_login_configs where tenant_id = ${tenant}`,
    sql`delete from activity_log where tenant_id = ${tenant}`,
    sql`delete from ads_daily_facts where tenant_id = ${tenant}`,
    sql`delete from ads_sync_runs where tenant_id = ${tenant}`,
    sql`delete from marketing_campaigns where tenant_id = ${tenant}`,
    sql`delete from notifications where tenant_id = ${tenant}`,
    sql`delete from notification_rules where tenant_id = ${tenant}`,
    sql`delete from message_templates where tenant_id = ${tenant}`,
    sql`delete from outbound_webhook_deliveries where tenant_id = ${tenant}`,
    sql`delete from outbound_webhooks where tenant_id = ${tenant}`,
    sql`delete from calls where tenant_id = ${tenant}`,
    sql`delete from connector_secrets where connector_id in (select id from connectors where tenant_id = ${tenant})`,
    sql`delete from connector_events where connector_id in (select id from connectors where tenant_id = ${tenant})`,
    sql`delete from communication_endpoints where tenant_id = ${tenant}`,
    sql`delete from connectors where tenant_id = ${tenant}`,
    sql`delete from allocation_rules where tenant_id = ${tenant}`,
    sql`delete from crm_outcomes where tenant_id = ${tenant}`,
    sql`delete from custom_field_definitions where tenant_id = ${tenant}`,
    sql`delete from treatment_definitions where tenant_id = ${tenant}`,
    sql`delete from specialty_templates where tenant_id = ${tenant}`,
    sql`delete from tasks where tenant_id = ${tenant}`,
    sql`delete from followup_types where tenant_id = ${tenant}`,
    sql`delete from departments where tenant_id = ${tenant}`,
    sql`delete from lead_sources where tenant_id = ${tenant}`,
    sql`delete from tenant_settings where tenant_id = ${tenant}`,
    sql`delete from sessions where user_id in (select id from users where tenant_id = ${tenant})`,
    sql`delete from users where tenant_id = ${tenant}`,
    sql`delete from branches where tenant_id = ${tenant}`,
    sql`delete from tenants where id = ${tenant}`,
  ];
  for (const st of statements) await db.execute(st);
}
