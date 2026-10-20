import { and, asc, desc, eq, gte, inArray, lt, ne, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  CAPABILITIES,
  CAPABILITY_DEPENDENCIES,
  EDITION_CAPABILITIES,
  LOCKED_CAPABILITIES,
  LOGIN_LOGO_PATH_PATTERN,
  SURFACE_STYLES,
  TENANT_STATUSES,
  TENANT_TRANSITIONS,
  resolveCapabilities,
  type Capability,
  type CapabilityMap,
  type Edition,
  type TenantLifecycleAction,
  type TenantStatus,
} from "@pulseos/types";
import type { Db, DbOrTx } from "../../db/client.js";
import {
  accountTokens,
  appointments,
  branches,
  calls,
  connectorEvents,
  connectors,
  conversations,
  departments,
  journeys,
  leadSources,
  outboundWebhookDeliveries,
  patients,
  sessions,
  tenantCapabilities,
  tenantLoginConfigs,
  tenantProfiles,
  tenants,
  users,
} from "../../db/schema.js";
import { installDepartmentTemplate } from "../specialty/department.service.js";
import { DEPARTMENT_TEMPLATES } from "../specialty/department-templates.js";
import { createLeadSource, ensureLeadSources, updateLeadSource } from "../lead/lead-source.service.js";
import { updateDepartment } from "../specialty/department.service.js";
import { RESERVED_SLUGS } from "../auth/signup.service.js";
import { resolveCapabilitiesForTenants } from "../capability/capability.service.js";
import { listHubForTenants, type TenantHubCard } from "../integration/hub.service.js";
import { recordPlatformAudit, type AuditActor } from "./audit.service.js";
import { deliverAccountToken, issueAccountToken, type IssuedToken } from "./account-tokens.service.js";
import { integrationAttention, integrationBucket, isConfiguredIntegration } from "./integration-health.js";
import { getPlatformSettings, isTimeZone } from "./platform-settings.service.js";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const SOURCE_BUCKETS = ["meta", "google", "website", "whatsapp", "phone", "walk_in", "referral", "organic", "other"] as const;

const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const slugSchema = z.string().trim().toLowerCase().regex(SLUG, "Lower-case letters, digits and dashes; 3–40 characters, starting with a letter").refine((s) => !RESERVED_SLUGS.has(s), "That address is reserved");
const tzSchema = z.string().trim().min(3).max(64).refine(isTimeZone, "Unknown time zone");
const localeSchema = z.string().trim().regex(/^[a-z]{2}(-[A-Z]{2})?$/, "Use a locale like en-IN");
const environmentSchema = z.enum(["PRODUCTION", "DEMO", "TEST"]);
const editionSchema = z.enum(["BETA_V1_CORE", "BETA_V2_GROWTH"]);
const optionalWords = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v ? v : null));

export const brandingSchema = z
  .object({
    shortName: optionalWords(40),
    logoPath: z.string().trim().nullable().optional().transform((v) => (v ? v : null)).refine((v) => v === null || LOGIN_LOGO_PATH_PATTERN.test(v), "Logo must be a file in /brand (svg, png or webp)"),
    headline: optionalWords(120),
    tagline: optionalWords(160),
    badgeLabel: optionalWords(24),
    supportText: optionalWords(160),
  })
  .strict();

export const createTenantSchema = z
  .object({
    creationKey: z.string().uuid(),
    organization: z
      .object({ name: text(2, 120), slug: slugSchema, industry: text(2, 60), country: text(2, 60), timezone: tzSchema, locale: localeSchema, environment: environmentSchema.default("PRODUCTION") })
      .strict(),
    plan: z.object({ edition: editionSchema, capabilityOverrides: z.record(z.enum(CAPABILITIES), z.boolean()).default({}) }).strict(),
    setup: z
      .object({
        branches: z.array(z.object({ name: text(2, 80), city: text(2, 80) }).strict()).min(1).max(20),
        departmentTemplates: z.array(z.string()).max(10).default([]),
        customLeadSources: z.array(z.object({ label: text(1, 60), bucket: z.enum(SOURCE_BUCKETS).default("other") }).strict()).max(20).default([]),
        branding: brandingSchema.optional(),
      })
      .strict(),
    admin: z.object({ name: text(2, 80), email: z.string().trim().toLowerCase().email().max(254), role: z.enum(["SUPER_ADMIN", "HOSPITAL_ADMIN"]) }).strict(),
  })
  .strict();
export type CreateTenantInput = z.infer<typeof createTenantSchema>;

export const editTenantSchema = z
  .object({ version: z.number().int().positive(), name: text(2, 120).optional(), loginSlug: slugSchema.optional(), industry: text(2, 60).optional(), country: text(2, 60).optional(), timezone: tzSchema.optional(), locale: localeSchema.optional(), environment: environmentSchema.optional() })
  .strict();

export const lifecycleSchema = z.object({ action: z.enum(["START_ONBOARDING", "ACTIVATE", "SUSPEND", "REACTIVATE", "ARCHIVE"]), version: z.number().int().positive(), reason: text(5, 500) }).strict();

export const listTenantsSchema = z
  .object({
    q: z.string().trim().max(120).optional(),
    status: z.enum(TENANT_STATUSES as [TenantStatus, ...TenantStatus[]]).optional(),
    edition: editionSchema.optional(),
    industry: z.string().trim().max(60).optional(),
    environment: environmentSchema.optional(),
    health: z.enum(["healthy", "attention", "not_configured"]).optional(),
    createdFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    createdTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    sort: z.enum(["created", "name", "status", "lastActivity"]).default("created"),
    dir: z.enum(["asc", "desc"]).default("desc"),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

type Result<T> = ({ ok: true } & T) | { ok: false; reason: string; status?: number; detail?: unknown };

/** A tenant as the console shows it. Configuration and identity only: nothing patient-level, nothing secret. */
export function tenantVm(t: typeof tenants.$inferSelect) {
  return {
    id: t.id,
    name: t.name,
    loginSlug: t.loginSlug,
    status: t.status,
    statusReason: t.statusReason,
    statusChangedAt: t.statusChangedAt?.toISOString() ?? null,
    environment: t.environment,
    edition: t.edition,
    industry: t.industry,
    country: t.country,
    timezone: t.timezone,
    locale: t.locale,
    surfaceStyle: t.surfaceStyle,
    version: t.version,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/** Capability overrides that leave an impossible combination (a dependency off, a locked capability off) are refused. */
export function capabilityProblems(map: CapabilityMap): string[] {
  const problems: string[] = [];
  for (const c of LOCKED_CAPABILITIES) if (!map[c]) problems.push(`${c} cannot be switched off`);
  for (const c of CAPABILITIES) if (map[c]) for (const d of CAPABILITY_DEPENDENCIES[c] ?? []) if (!map[d]) problems.push(`${c} needs ${d}`);
  return problems;
}

class Rollback extends Error {
  constructor(readonly reason: string, readonly status: number) {
    super(reason);
  }
}

const isUniqueViolation = (err: unknown, constraint: string) => {
  const e = err as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } };
  const c = e?.code === "23505" ? e : e?.cause?.code === "23505" ? e.cause : null;
  return !!c && (c.constraint_name ?? "").includes(constraint);
};

/**
 * Create a tenant in ONE transaction: tenant, sign-in page, branches, departments, lead sources, capability overrides, the
 * first admin (an INVITED account with no password) and their invitation. Any failure rolls all of it back. A repeated
 * submission with the same creationKey returns the first tenant (200) instead of creating another; the invitation link is
 * sent only after the transaction commits.
 */
export async function createTenant(db: Db, input: CreateTenantInput, actor: AuditActor): Promise<Result<{ created: boolean; tenant: ReturnType<typeof tenantVm>; invitation: { id: string; deliveryStatus: string } | null }>> {
  const overrides = input.plan.capabilityOverrides as Partial<Record<Capability, boolean>>;
  const problems = capabilityProblems(resolveCapabilities(input.plan.edition, overrides));
  if (problems.length) return { ok: false, reason: "invalid_capabilities", status: 400, detail: problems };
  for (const key of input.setup.departmentTemplates) if (!DEPARTMENT_TEMPLATES.some((t) => t.key === key)) return { ok: false, reason: "unknown_department_template", status: 400 };

  let issued: IssuedToken | null = null;
  let outcome: { created: boolean; tenant: typeof tenants.$inferSelect; adminName: string };
  try {
    outcome = await db.transaction(async (tx) => {
      // One submission at a time per key: a double-click waits here, then finds the first request's tenant.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tenant-create:${input.creationKey}`}))`);
      const [already] = await tx.select().from(tenants).where(eq(tenants.creationKey, input.creationKey)).limit(1);
      if (already) return { created: false, tenant: already, adminName: input.admin.name };
      const [slugTaken] = await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.loginSlug, input.organization.slug)).limit(1);
      if (slugTaken) throw new Rollback("slug_taken", 409);

      const o = input.organization;
      const [tenant] = await tx
        .insert(tenants)
        .values({ name: o.name, loginSlug: o.slug, industry: o.industry, country: o.country, timezone: o.timezone, locale: o.locale, environment: o.environment, edition: input.plan.edition, status: "DRAFT", statusChangedAt: new Date(), createdByPlatformUserId: actor.platformUserId, creationKey: input.creationKey })
        .returning();
      const t = tenant!;
      await tx.insert(tenantLoginConfigs).values({ tenantId: t.id, ...(input.setup.branding ?? {}) });
      const createdBranches = await tx.insert(branches).values(input.setup.branches.map((b) => ({ tenantId: t.id, name: b.name, city: b.city }))).returning({ id: branches.id });
      const txDb = tx as unknown as Db;
      for (const key of input.setup.departmentTemplates) {
        const r = await installDepartmentTemplate(txDb, t.id, key);
        if (!r.ok) throw new Rollback(r.reason, 400);
      }
      await ensureLeadSources(txDb, t.id);
      for (const s of input.setup.customLeadSources) {
        const r = await createLeadSource(txDb, t.id, { label: s.label, bucket: s.bucket });
        if (!r.ok) throw new Rollback(r.reason === "source_exists" ? "duplicate_lead_source" : r.reason, r.reason === "source_exists" ? 409 : 400);
      }
      const defaults = new Set(EDITION_CAPABILITIES[input.plan.edition as Edition]);
      const realOverrides = Object.entries(overrides).filter(([k, v]) => defaults.has(k as Capability) !== v);
      if (realOverrides.length) await tx.insert(tenantCapabilities).values(realOverrides.map(([capability, enabled]) => ({ tenantId: t.id, capability, enabled: !!enabled })));

      const [adminUser] = await tx
        .insert(users)
        .values({ tenantId: t.id, branchId: createdBranches[0]!.id, name: input.admin.name, email: input.admin.email, passwordHash: null, role: input.admin.role, status: "INVITED" })
        .returning();
      await tx.update(tenants).set({ primaryAdminUserId: adminUser!.id }).where(eq(tenants.id, t.id));
      issued = await issueAccountToken(tx, { userId: adminUser!.id, purpose: "INVITE", tenantId: t.id, email: input.admin.email, role: input.admin.role, createdBy: actor.platformUserId });

      await recordPlatformAudit(tx, actor, {
        action: "tenant.created",
        summary: `Created tenant ${o.name} (${o.slug})`,
        targetType: "tenant",
        targetId: t.id,
        tenantId: t.id,
        metadata: { slug: o.slug, edition: input.plan.edition, environment: o.environment, branches: input.setup.branches.length, departmentTemplates: input.setup.departmentTemplates, customLeadSources: input.setup.customLeadSources.length, capabilityOverrides: Object.fromEntries(realOverrides) },
      });
      await recordPlatformAudit(tx, actor, { action: "invitation.created", summary: `Invited ${input.admin.email} as ${input.admin.role} of ${o.name}`, targetType: "user", targetId: adminUser!.id, tenantId: t.id, metadata: { role: input.admin.role } });
      return { created: true, tenant: { ...t, primaryAdminUserId: adminUser!.id }, adminName: input.admin.name };
    });
  } catch (err) {
    if (err instanceof Rollback) return { ok: false, reason: err.reason, status: err.status };
    if (isUniqueViolation(err, "tenants_login_slug_unique")) return { ok: false, reason: "slug_taken", status: 409 };
    if (isUniqueViolation(err, "tenants_creation_key_unique")) {
      const [t] = await db.select().from(tenants).where(eq(tenants.creationKey, input.creationKey)).limit(1);
      if (t) return { ok: true, created: false, tenant: tenantVm(t), invitation: null };
    }
    throw err;
  }

  let invitation: { id: string; deliveryStatus: string } | null = null;
  if (outcome.created && issued) {
    const sent: IssuedToken = issued;
    invitation = { id: sent.id, deliveryStatus: await deliverAccountToken(db, sent, { name: outcome.adminName, workspace: outcome.tenant.name }) };
  }
  return { ok: true, created: outcome.created, tenant: tenantVm(outcome.tenant), invitation };
}

const ilikeEscape = (q: string) => `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

/** The tenant directory: filtered, sorted and paged by the database. Integration figures come from the same Hub derivation. */
export async function listTenants(db: Db, f: z.infer<typeof listTenantsSchema>) {
  const conds: SQL[] = [];
  if (f.status) conds.push(eq(tenants.status, f.status));
  if (f.edition) conds.push(eq(tenants.edition, f.edition));
  if (f.environment) conds.push(eq(tenants.environment, f.environment));
  if (f.industry) conds.push(sql`lower(coalesce(${tenants.industry}, '')) = lower(${f.industry})`);
  if (f.createdFrom) conds.push(gte(tenants.createdAt, new Date(`${f.createdFrom}T00:00:00+05:30`)));
  if (f.createdTo) conds.push(lt(tenants.createdAt, new Date(new Date(`${f.createdTo}T00:00:00+05:30`).getTime() + 86400000)));
  if (f.q) {
    const like = ilikeEscape(f.q);
    conds.push(
      sql`(${tenants.name} ilike ${like} or coalesce(${tenants.loginSlug}, '') ilike ${like} or exists (
        select 1 from ${users} a where a.tenant_id = ${tenants.id} and a.role in ('SUPER_ADMIN', 'HOSPITAL_ADMIN') and not a.is_system
        and (a.name ilike ${like} or a.email ilike ${like})))`,
    );
  }
  const where = conds.length ? and(...conds) : undefined;
  const lastActivity = sql<Date | null>`(select max(u.last_sign_in_at) from ${users} u where u.tenant_id = ${tenants.id})`;
  const order = (() => {
    const d = f.dir === "asc" ? asc : desc;
    switch (f.sort) {
      case "name":
        return [d(tenants.name)];
      case "status":
        return [d(tenants.status), asc(tenants.name)];
      case "lastActivity":
        return [f.dir === "asc" ? sql`${lastActivity} asc nulls first` : sql`${lastActivity} desc nulls last`];
      default:
        return [d(tenants.createdAt)];
    }
  })();

  // The integration-health filter needs every candidate's Hub; anything else pages in the database.
  let ids: string[] | null = null;
  let total: number;
  if (f.health) {
    const candidates = await db.select({ id: tenants.id, edition: tenants.edition }).from(tenants).where(where).orderBy(...order, asc(tenants.id));
    const caps = await resolveCapabilitiesForTenants(db, candidates);
    const hubs = await listHubForTenants(db, candidates.map((c) => ({ id: c.id, caps: caps.get(c.id)! })));
    const matching = candidates.filter((c) => {
      const cards = hubs.get(c.id) ?? [];
      if (f.health === "attention") return cards.some((card) => integrationAttention(card));
      if (f.health === "healthy") return cards.some((card) => isConfiguredIntegration(card)) && !cards.some((card) => integrationAttention(card));
      return !cards.some((card) => isConfiguredIntegration(card));
    });
    total = matching.length;
    ids = matching.slice((f.page - 1) * f.pageSize, f.page * f.pageSize).map((c) => c.id);
  } else {
    const [c] = await db.select({ n: sql<number>`count(*)::int` }).from(tenants).where(where);
    total = c?.n ?? 0;
  }

  const base = db
    .select({
      t: tenants,
      profileIndustry: tenantProfiles.industry,
      adminName: users.name,
      adminEmail: users.email,
      adminStatus: users.status,
      userCount: sql<number>`(select count(*) from ${users} u where u.tenant_id = ${tenants.id} and not u.is_system and u.status <> 'REMOVED')::int`,
      branchCount: sql<number>`(select count(*) from ${branches} b where b.tenant_id = ${tenants.id})::int`,
      lastActivity,
    })
    .from(tenants)
    .leftJoin(users, eq(users.id, tenants.primaryAdminUserId))
    .leftJoin(tenantProfiles, eq(tenantProfiles.tenantId, tenants.id));
  const rows = ids
    ? ids.length
      ? await base.where(inArray(tenants.id, ids)).orderBy(...order, asc(tenants.id))
      : []
    : await base.where(where).orderBy(...order, asc(tenants.id)).limit(f.pageSize).offset((f.page - 1) * f.pageSize);

  const caps = await resolveCapabilitiesForTenants(db, rows.map((r) => ({ id: r.t.id, edition: r.t.edition })));
  const hubs = await listHubForTenants(db, rows.map((r) => ({ id: r.t.id, caps: caps.get(r.t.id)! })));
  return {
    rows: rows.map((r) => {
      const map = caps.get(r.t.id)!;
      const cards = hubs.get(r.t.id) ?? [];
      return {
        ...tenantVm(r.t),
        industry: r.t.industry ?? r.profileIndustry ?? null,
        primaryAdmin: r.adminEmail ? { name: r.adminName!, email: r.adminEmail, status: r.adminStatus! } : null,
        users: r.userCount,
        branches: r.branchCount,
        modules: { enabled: CAPABILITIES.filter((c) => map[c]).length, total: CAPABILITIES.length },
        integrations: { configured: cards.filter(isConfiguredIntegration).length, attention: cards.filter((c) => integrationAttention(c)).length },
        lastActivityAt: r.lastActivity ? new Date(r.lastActivity).toISOString() : null,
      };
    }),
    total,
    page: f.page,
    pageSize: f.pageSize,
  };
}

/** Distinct industries, for the directory filter. */
export async function tenantIndustries(db: Db): Promise<string[]> {
  const rows = await db.selectDistinct({ industry: sql<string>`coalesce(${tenants.industry}, ${tenantProfiles.industry})` }).from(tenants).leftJoin(tenantProfiles, eq(tenantProfiles.tenantId, tenants.id));
  return rows.map((r) => r.industry).filter((v): v is string => !!v).sort();
}

export async function loadTenant(db: DbOrTx, id: string) {
  if (!UUID.test(id)) return null;
  const [t] = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
  return t ?? null;
}

type ChecklistItem = { key: string; label: string; done: boolean; detail?: string };

/**
 * One tenant for the console: identity, high-level counts, admins, integration state, and an onboarding checklist that is
 * derived only from real rows. Aggregates only - no patient, journey or call content, no recording reference, no secret.
 */
export async function getTenantDetail(db: Db, id: string) {
  const t = await loadTenant(db, id);
  if (!t) return null;
  const count = async (table: typeof users | typeof branches | typeof patients | typeof journeys | typeof calls | typeof appointments, extra?: SQL) => {
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(table).where(extra ? and(eq(table.tenantId, id), extra) : eq(table.tenantId, id));
    return r?.n ?? 0;
  };
  const [profile] = await db.select().from(tenantProfiles).where(eq(tenantProfiles.tenantId, id)).limit(1);
  const [loginCfg] = await db.select().from(tenantLoginConfigs).where(eq(tenantLoginConfigs.tenantId, id)).limit(1);
  const [deps] = await db.select({ n: sql<number>`count(*) filter (where not ${departments.archived})::int` }).from(departments).where(eq(departments.tenantId, id));
  const [sources] = await db.select({ n: sql<number>`count(*) filter (where not ${leadSources.archived})::int` }).from(leadSources).where(eq(leadSources.tenantId, id));
  const counts = {
    users: await count(users, sql`not ${users.isSystem} and ${users.status} <> 'REMOVED'`),
    branches: await count(branches),
    departments: deps?.n ?? 0,
    leadSources: sources?.n ?? 0,
    patients: await count(patients),
    journeys: await count(journeys),
    calls: await count(calls),
    appointments: await count(appointments),
  };
  const admins = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, status: users.status, lastSignInAt: users.lastSignInAt })
    .from(users)
    .where(and(eq(users.tenantId, id), inArray(users.role, ["SUPER_ADMIN", "HOSPITAL_ADMIN"]), eq(users.isSystem, false), ne(users.status, "REMOVED")))
    .orderBy(asc(users.createdAt));
  const [lastLogin] = await db.select({ at: sql<Date | null>`max(${users.lastSignInAt})` }).from(users).where(eq(users.tenantId, id));
  const [pendingInvites] = await db.select({ n: sql<number>`count(*)::int` }).from(accountTokens).where(and(eq(accountTokens.tenantId, id), eq(accountTokens.purpose, "INVITE"), eq(accountTokens.status, "PENDING"), sql`${accountTokens.expiresAt} > now()`));
  const [anyInvite] = await db.select({ n: sql<number>`count(*)::int` }).from(accountTokens).where(and(eq(accountTokens.tenantId, id), eq(accountTokens.purpose, "INVITE")));

  const caps = (await resolveCapabilitiesForTenants(db, [{ id, edition: t.edition }])).get(id)!;
  const cards: TenantHubCard[] = (await listHubForTenants(db, [{ id, caps }])).get(id) ?? [];
  // Recent integration activity: when and how events were handled - never their payload.
  const recentEvents = await db
    .select({ at: connectorEvents.receivedAt, status: connectorEvents.status, direction: connectorEvents.direction, provider: connectors.provider, displayName: connectors.displayName })
    .from(connectorEvents)
    .innerJoin(connectors, eq(connectors.id, connectorEvents.connectorId))
    .where(eq(connectorEvents.tenantId, id))
    .orderBy(desc(connectorEvents.receivedAt))
    .limit(8);

  const activeAdmin = admins.some((a) => a.status === "ACTIVE");
  const attention = cards.filter((c) => integrationAttention(c));
  const configured = cards.filter(isConfiguredIntegration);
  const checklist: ChecklistItem[] = [
    { key: "created", label: "Tenant created", done: true },
    { key: "admin_invited", label: "Admin invited", done: (anyInvite?.n ?? 0) > 0 || admins.length > 0 },
    { key: "admin_accepted", label: "Admin accepted", done: activeAdmin, detail: activeAdmin ? undefined : "No administrator has set a password yet" },
    { key: "branch", label: "Branch configured", done: counts.branches > 0 },
    { key: "departments", label: "Departments configured", done: counts.departments > 0 },
    { key: "lead_sources", label: "Lead sources configured", done: counts.leadSources > 0 },
    { key: "branding", label: "Sign-in page branded", done: !!t.loginSlug && !!(loginCfg?.logoPath || loginCfg?.headline || loginCfg?.shortName), detail: t.loginSlug ? undefined : "No sign-in address yet" },
    { key: "integrations", label: "Integrations healthy", done: attention.length === 0, detail: `${configured.length} configured · ${attention.length} needing attention` },
    { key: "first_login", label: "First successful sign-in", done: !!lastLogin?.at },
    { key: "first_journey", label: "First lead / journey created", done: counts.journeys > 0 },
  ];
  const setupKeys = ["admin_invited", "branch", "departments", "lead_sources"];
  const readiness =
    t.status === "SUSPENDED" || t.status === "ARCHIVED"
      ? null
      : t.status === "ACTIVE"
        ? attention.length > 0 || !activeAdmin
          ? "NEEDS_ATTENTION"
          : "ACTIVE"
        : checklist.filter((c) => setupKeys.includes(c.key)).every((c) => c.done)
          ? "READY_FOR_CLIENT"
          : "SETUP_INCOMPLETE";

  return {
    tenant: { ...tenantVm(t), industry: t.industry ?? profile?.industry ?? null, country: t.country ?? profile?.country ?? null, source: profile?.source ?? "platform", primaryAdminUserId: t.primaryAdminUserId },
    loginPath: t.loginSlug ? `/login/${t.loginSlug}` : null,
    counts,
    admins: admins.map((a) => ({ ...a, lastSignInAt: a.lastSignInAt?.toISOString() ?? null, primary: a.id === t.primaryAdminUserId })),
    lastLoginAt: lastLogin?.at ? new Date(lastLogin.at).toISOString() : null,
    pendingInvitations: pendingInvites?.n ?? 0,
    capabilities: { enabled: CAPABILITIES.filter((c) => caps[c]).length, total: CAPABILITIES.length },
    integrations: cards.map((c) => ({ key: c.key, name: c.name, category: c.category, enabled: c.enabled, configuration: c.configuration, credentialState: c.credentialState, health: c.health, mode: c.mode, lastEventAt: c.lastEventAt, lastError: c.lastError, endpointCount: c.endpointCount, attention: integrationAttention(c), bucket: integrationBucket(c), blockedReason: c.blockedReason })),
    recentIntegrationEvents: recentEvents.map((e) => ({ ...e, at: e.at.toISOString() })),
    checklist,
    readiness,
    branding: loginCfg ? { shortName: loginCfg.shortName, logoPath: loginCfg.logoPath, headline: loginCfg.headline, tagline: loginCfg.tagline, badgeLabel: loginCfg.badgeLabel, supportText: loginCfg.supportText, updatedAt: loginCfg.updatedAt.toISOString() } : null,
  };
}

/** Optimistic, versioned edit of a tenant's basic details. A stale version is refused, never silently overwritten. */
export async function editTenant(db: Db, id: string, input: z.infer<typeof editTenantSchema>, actor: AuditActor): Promise<Result<{ tenant: ReturnType<typeof tenantVm> }>> {
  try {
    return await db.transaction(async (tx) => {
      const [t] = await tx.select().from(tenants).where(eq(tenants.id, id)).for("update").limit(1);
      if (!t) return { ok: false as const, reason: "not_found", status: 404 };
      if (t.version !== input.version) return { ok: false as const, reason: "stale_version", status: 409 };
      const { version: _v, ...fields } = input;
      void _v;
      const changed = Object.entries(fields).filter(([k, v]) => v !== undefined && (t as Record<string, unknown>)[k] !== v);
      if (changed.length === 0) return { ok: true as const, tenant: tenantVm(t) };
      const [updated] = await tx
        .update(tenants)
        .set({ ...Object.fromEntries(changed), updatedAt: new Date(), version: t.version + 1 })
        .where(eq(tenants.id, id))
        .returning();
      await recordPlatformAudit(tx, actor, {
        action: "tenant.updated",
        summary: `Updated ${changed.map(([k]) => k).join(", ")} of ${updated!.name}`,
        targetType: "tenant",
        targetId: id,
        tenantId: id,
        metadata: { changes: Object.fromEntries(changed.map(([k, v]) => [k, { from: (t as Record<string, unknown>)[k] ?? null, to: v }])) },
      });
      return { ok: true as const, tenant: tenantVm(updated!) };
    });
  } catch (err) {
    if (isUniqueViolation(err, "tenants_login_slug_unique")) return { ok: false, reason: "slug_taken", status: 409 };
    throw err;
  }
}

const LIFECYCLE_AUDIT: Record<TenantLifecycleAction, string> = {
  START_ONBOARDING: "tenant.onboarding_started",
  ACTIVATE: "tenant.activated",
  SUSPEND: "tenant.suspended",
  REACTIVATE: "tenant.reactivated",
  ARCHIVE: "tenant.archived",
};

/**
 * Move a tenant through its lifecycle. Only the transitions in TENANT_TRANSITIONS exist; every one needs a reason and the
 * version the person was looking at. Suspending or archiving ends every open staff session immediately (sign-in is refused
 * from then on) and keeps every row. Nothing here can delete a tenant.
 */
export async function changeTenantLifecycle(db: Db, id: string, input: z.infer<typeof lifecycleSchema>, actor: AuditActor): Promise<Result<{ tenant: ReturnType<typeof tenantVm> }>> {
  return db.transaction(async (tx) => {
    const [t] = await tx.select().from(tenants).where(eq(tenants.id, id)).for("update").limit(1);
    if (!t) return { ok: false as const, reason: "not_found", status: 404 };
    if (t.version !== input.version) return { ok: false as const, reason: "stale_version", status: 409 };
    const transition = TENANT_TRANSITIONS[input.action];
    if (!transition.from.includes(t.status)) return { ok: false as const, reason: "invalid_transition", status: 409 };
    const now = new Date();
    const [updated] = await tx
      .update(tenants)
      .set({ status: transition.to, statusReason: input.reason, statusChangedAt: now, updatedAt: now, version: t.version + 1 })
      .where(eq(tenants.id, id))
      .returning();
    let endedSessions = 0;
    if (transition.to === "SUSPENDED" || transition.to === "ARCHIVED") {
      const ended = await tx.delete(sessions).where(inArray(sessions.userId, tx.select({ id: users.id }).from(users).where(eq(users.tenantId, id)))).returning({ id: sessions.id });
      endedSessions = ended.length;
    }
    await recordPlatformAudit(tx, actor, {
      action: LIFECYCLE_AUDIT[input.action],
      summary: `${transition.label}: ${t.name} (${t.status} → ${transition.to})`,
      targetType: "tenant",
      targetId: id,
      tenantId: id,
      reason: input.reason,
      metadata: { from: t.status, to: transition.to, endedSessions },
    });
    return { ok: true as const, tenant: tenantVm(updated!) };
  });
}

/** The tenant's own sign-in page words (tenant-owned configuration; the console only assists). */
export async function saveTenantBranding(db: Db, id: string, input: z.infer<typeof brandingSchema>, actor: AuditActor): Promise<Result<object>> {
  return db.transaction(async (tx) => {
    const t = await loadTenant(tx, id);
    if (!t) return { ok: false as const, reason: "not_found", status: 404 };
    await tx.insert(tenantLoginConfigs).values({ tenantId: id, ...input, updatedAt: new Date() }).onConflictDoUpdate({ target: tenantLoginConfigs.tenantId, set: { ...input, updatedAt: new Date() } });
    await recordPlatformAudit(tx, actor, { action: "tenant.branding_updated", summary: `Updated the sign-in page of ${t.name}`, targetType: "tenant", targetId: id, tenantId: id, metadata: { fields: Object.keys(input) } });
    return { ok: true as const };
  });
}

export const appearanceSchema = z.object({ surfaceStyle: z.enum(SURFACE_STYLES) }).strict();

export async function saveTenantAppearance(db: Db, id: string, input: z.infer<typeof appearanceSchema>, actor: AuditActor): Promise<Result<object>> {
  return db.transaction(async (tx) => {
    const t = await loadTenant(tx, id);
    if (!t) return { ok: false as const, reason: "not_found", status: 404 };
    await tx.update(tenants).set({ surfaceStyle: input.surfaceStyle, updatedAt: new Date() }).where(eq(tenants.id, id));
    await recordPlatformAudit(tx, actor, { action: "tenant.appearance_updated", summary: `Set the interface style of ${t.name} to ${input.surfaceStyle}`, targetType: "tenant", targetId: id, tenantId: id, metadata: { from: t.surfaceStyle, to: input.surfaceStyle } });
    return { ok: true as const };
  });
}

/** Which admin account is the tenant's primary contact. Must be an admin-role, non-removed account of THIS tenant. */
export async function setPrimaryAdmin(db: Db, id: string, userId: string, actor: AuditActor): Promise<Result<object>> {
  if (!UUID.test(userId)) return { ok: false, reason: "not_found", status: 404 };
  return db.transaction(async (tx) => {
    const t = await loadTenant(tx, id);
    if (!t) return { ok: false as const, reason: "not_found", status: 404 };
    const [u] = await tx.select().from(users).where(and(eq(users.id, userId), eq(users.tenantId, id), eq(users.isSystem, false))).limit(1);
    if (!u) return { ok: false as const, reason: "not_found", status: 404 };
    if (!["SUPER_ADMIN", "HOSPITAL_ADMIN"].includes(u.role) || u.status === "REMOVED" || u.status === "SUSPENDED") return { ok: false as const, reason: "not_an_admin", status: 409 };
    await tx.update(tenants).set({ primaryAdminUserId: u.id, updatedAt: new Date() }).where(eq(tenants.id, id));
    await recordPlatformAudit(tx, actor, { action: "tenant.primary_admin_changed", summary: `${u.email} is now the primary admin of ${t.name}`, targetType: "user", targetId: u.id, tenantId: id, metadata: { from: t.primaryAdminUserId, to: u.id } });
    return { ok: true as const };
  });
}

/** Branches, departments and lead sources: the tenant's own configuration rows (read for the console). */
export async function getTenantConfiguration(db: Db, id: string) {
  const t = await loadTenant(db, id);
  if (!t) return null;
  const [b, d, s] = await Promise.all([
    db.select({ id: branches.id, name: branches.name, city: branches.city, createdAt: branches.createdAt }).from(branches).where(eq(branches.tenantId, id)).orderBy(asc(branches.createdAt)),
    db.select({ id: departments.id, key: departments.key, displayName: departments.displayName, archived: departments.archived, templateKey: departments.templateKey }).from(departments).where(eq(departments.tenantId, id)).orderBy(asc(departments.sortOrder)),
    db.select({ id: leadSources.id, key: leadSources.key, label: leadSources.label, bucket: leadSources.bucket, archived: leadSources.archived }).from(leadSources).where(eq(leadSources.tenantId, id)).orderBy(asc(leadSources.sortOrder)),
  ]);
  const installed = new Set(d.map((x) => x.templateKey).filter(Boolean));
  return {
    branches: b.map((x) => ({ ...x, createdAt: x.createdAt.toISOString() })),
    departments: d,
    leadSources: s,
    availableDepartmentTemplates: DEPARTMENT_TEMPLATES.filter((t) => !installed.has(t.key)).map((t) => ({ key: t.key, displayName: t.displayName, description: t.description })),
  };
}

export const branchSchema = z.object({ name: text(2, 80), city: text(2, 80) }).strict();
export const departmentInstallSchema = z.object({ templateKey: z.string().min(1).max(60) }).strict();
export const departmentUpdateSchema = z.object({ displayName: text(1, 80).optional(), archived: z.boolean().optional() }).strict();
export const leadSourceCreateSchema = z.object({ label: text(1, 60), bucket: z.enum(SOURCE_BUCKETS).default("other") }).strict();
export const leadSourceUpdateSchema = z.object({ label: text(1, 60).optional(), bucket: z.enum(SOURCE_BUCKETS).optional(), archived: z.boolean().optional() }).strict();

/**
 * Configuration help through the SAME services the hospital's own Settings use (departments, lead sources); branches are
 * plain rows of the tenant's own table. Every change is audited against the platform actor.
 */
export async function changeTenantConfiguration(
  db: Db,
  id: string,
  change:
    | { kind: "branch.create"; input: z.infer<typeof branchSchema> }
    | { kind: "branch.update"; branchId: string; input: z.infer<typeof branchSchema> }
    | { kind: "department.install"; input: z.infer<typeof departmentInstallSchema> }
    | { kind: "department.update"; departmentId: string; input: z.infer<typeof departmentUpdateSchema> }
    | { kind: "lead_source.create"; input: z.infer<typeof leadSourceCreateSchema> }
    | { kind: "lead_source.update"; sourceId: string; input: z.infer<typeof leadSourceUpdateSchema> },
  actor: AuditActor,
): Promise<Result<object>> {
  return db.transaction(async (tx) => {
    const t = await loadTenant(tx, id);
    if (!t) return { ok: false as const, reason: "not_found", status: 404 };
    const txDb = tx as unknown as Db;
    let r: { ok: boolean; reason?: string } = { ok: true };
    let targetId: string | null = null;
    switch (change.kind) {
      case "branch.create": {
        const [b] = await tx.insert(branches).values({ tenantId: id, ...change.input }).returning({ id: branches.id });
        targetId = b!.id;
        break;
      }
      case "branch.update": {
        if (!UUID.test(change.branchId)) return { ok: false as const, reason: "not_found", status: 404 };
        const upd = await tx.update(branches).set(change.input).where(and(eq(branches.id, change.branchId), eq(branches.tenantId, id))).returning({ id: branches.id });
        if (!upd.length) return { ok: false as const, reason: "not_found", status: 404 };
        targetId = change.branchId;
        break;
      }
      case "department.install":
        r = await installDepartmentTemplate(txDb, id, change.input.templateKey);
        break;
      case "department.update":
        if (!UUID.test(change.departmentId)) return { ok: false as const, reason: "not_found", status: 404 };
        r = await updateDepartment(txDb, id, change.departmentId, change.input);
        targetId = change.departmentId;
        break;
      case "lead_source.create":
        r = await createLeadSource(txDb, id, change.input);
        break;
      case "lead_source.update":
        if (!UUID.test(change.sourceId)) return { ok: false as const, reason: "not_found", status: 404 };
        r = await updateLeadSource(txDb, id, change.sourceId, change.input);
        targetId = change.sourceId;
        break;
    }
    if (!r.ok) {
      const reason = r.reason ?? "invalid_request";
      return { ok: false as const, reason, status: /not_found/.test(reason) ? 404 : /exists/.test(reason) ? 409 : 400 };
    }
    await recordPlatformAudit(tx, actor, { action: `tenant_config.${change.kind}`, summary: `${change.kind.replace(".", " ").replace("_", " ")} for ${t.name}`, targetType: change.kind.split(".")[0]!, targetId, tenantId: id, metadata: { fields: Object.keys(change.input) } });
    return { ok: true as const };
  });
}

/** Real operational counts for the Usage tab. Totals and the last 30 days; nothing is estimated. */
export async function getTenantUsage(db: Db, id: string) {
  const t = await loadTenant(db, id);
  if (!t) return null;
  const since = sql`now() - interval '30 days'`;
  const one = async (q: Promise<{ total: number; recent: number }[]>) => (await q)[0] ?? { total: 0, recent: 0 };
  const agg = (createdCol: SQL | ReturnType<typeof sql>) => ({ total: sql<number>`count(*)::int`, recent: sql<number>`count(*) filter (where ${createdCol} >= ${since})::int` });
  const [usersRow, patientsRow, journeysRow, callsRow, apptRow, eventsRow, webhookRow, recordingsRow, convRow] = await Promise.all([
    one(db.select(agg(sql`${users.createdAt}`)).from(users).where(and(eq(users.tenantId, id), eq(users.isSystem, false)))),
    one(db.select(agg(sql`${patients.createdAt}`)).from(patients).where(eq(patients.tenantId, id))),
    one(db.select(agg(sql`${journeys.createdAt}`)).from(journeys).where(eq(journeys.tenantId, id))),
    one(db.select(agg(sql`${calls.createdAt}`)).from(calls).where(eq(calls.tenantId, id))),
    one(db.select(agg(sql`${appointments.createdAt}`)).from(appointments).where(eq(appointments.tenantId, id))),
    one(db.select(agg(sql`${connectorEvents.receivedAt}`)).from(connectorEvents).where(eq(connectorEvents.tenantId, id))),
    one(db.select(agg(sql`${outboundWebhookDeliveries.createdAt}`)).from(outboundWebhookDeliveries).where(eq(outboundWebhookDeliveries.tenantId, id))),
    one(db.select(agg(sql`${calls.createdAt}`)).from(calls).where(and(eq(calls.tenantId, id), sql`${calls.recordingUrl} is not null`))),
    one(db.select(agg(sql`${conversations.createdAt}`)).from(conversations).where(eq(conversations.tenantId, id))),
  ]);
  return {
    windowDays: 30,
    metrics: [
      { key: "users", label: "Staff accounts", ...usersRow },
      { key: "patients", label: "Patients", ...patientsRow },
      { key: "journeys", label: "Journeys", ...journeysRow },
      { key: "appointments", label: "Appointments", ...apptRow },
      { key: "calls", label: "Calls", ...callsRow },
      { key: "recordings", label: "Calls with a recording", ...recordingsRow },
      { key: "conversations", label: "Conversations", ...convRow },
      { key: "integration_events", label: "Integration events", ...eventsRow },
      { key: "webhook_deliveries", label: "Outbound webhook deliveries", ...webhookRow },
    ],
  };
}

export { getPlatformSettings };
