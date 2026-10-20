import { resolveTenantCapabilities } from "../capability/capability.service.js";
import { hash, verify } from "@node-rs/argon2";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { users, sessions, tenants, branches, tenantLoginConfigs, tenantProfiles } from "../../db/schema.js";
import { TENANT_SIGN_IN_STATUSES, DEFAULT_EDITION, DEFAULT_INTERFACE_SIZE, DEFAULT_SURFACE_STYLE, DEFAULT_TEXT_SIZE, INTERFACE_SIZES, SURFACE_STYLES, TEXT_SIZES, type InterfaceSize, type SurfaceStyle, type TextSize, DEFAULT_LOGIN_SUPPORT_TEXT, DEFAULT_LOGIN_TAGLINE, LOGIN_LOGO_PATH_PATTERN, type DevEnvironment, type Role, type TenantLoginBranding } from "@pulseos/types";
import { DEFAULT_DEMO_ENVIRONMENT, DEMO_ENVIRONMENTS, DEMO_LOGIN_ROLES, demoEmailForRole, type DemoEnvironmentKey } from "./demo-environments.js";

const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
/** "Remember me": stay signed in on this device for a week. Without it the session ends after 12 hours or when the browser closes. */
export const REMEMBER_TTL_MS = 1000 * 60 * 60 * 24 * 7;
// Session ids are uuids. Anything else in the cookie (tampered, truncated, set by a
// sibling domain) is simply "no session" — never a database error that would
// 500 every request, including the login and logout that would clear it.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

/** A hospital that never chose an interface style (null) reads as the default. */
function toInterfaceSize(v: string | null | undefined): InterfaceSize {
  return (INTERFACE_SIZES as readonly string[]).includes(v ?? "") ? (v as InterfaceSize) : DEFAULT_INTERFACE_SIZE;
}
function toTextSize(v: string | null | undefined): TextSize {
  return (TEXT_SIZES as readonly string[]).includes(v ?? "") ? (v as TextSize) : DEFAULT_TEXT_SIZE;
}
function toSurfaceStyle(v: string | null | undefined): SurfaceStyle {
  return (SURFACE_STYLES as readonly string[]).includes(v ?? "") ? (v as SurfaceStyle) : DEFAULT_SURFACE_STYLE;
}

export async function verifyPassword(hashValue: string, plain: string): Promise<boolean> {
  return verify(hashValue, plain);
}

// Shared by password login and Dev Login — the only difference between them
// is how the target user is found (email+password vs. role lookup); once a
// `users` row is settled on, session creation is identical, so both go
// through one path rather than a parallel/weaker one for Dev Login.
/** Where a sign-in came from, kept on the session so platform staff can recognise it before revoking it. */
export interface SignInMeta {
  ip?: string | null;
  userAgent?: string | null;
}

async function createSessionFor(db: Db, user: typeof users.$inferSelect, remember = false, meta: SignInMeta = {}) {
  const now = new Date();
  const [session] = await db
    .insert(sessions)
    .values({ userId: user.id, expiresAt: new Date(now.getTime() + (remember ? REMEMBER_TTL_MS : SESSION_TTL_MS)), lastSeenAt: now, ipAddress: meta.ip ?? null, userAgent: meta.userAgent ?? null })
    .returning();
  await db.update(users).set({ lastSignInAt: now }).where(eq(users.id, user.id));

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, user.tenantId)).limit(1);
  const branch = user.branchId ? (await db.select().from(branches).where(eq(branches.id, user.branchId)).limit(1))[0] : undefined;
  const capabilities = await resolveTenantCapabilities(db, user.tenantId, tenant?.edition ?? DEFAULT_EDITION);

  return {
    ok: true as const,
    remember,
    sessionId: session.id,
    expiresAt: session.expiresAt,
    user: {
      id: user.id,
      tenantId: user.tenantId,
      tenantName: tenant?.name ?? "",
      loginSlug: tenant?.loginSlug ?? null,
      timezone: tenant?.timezone ?? "Asia/Kolkata",
      surfaceStyle: toSurfaceStyle(tenant?.surfaceStyle),
      interfaceSize: toInterfaceSize(user.interfaceSize),
      textSize: toTextSize(user.textSize),
      edition: tenant?.edition ?? DEFAULT_EDITION,
      capabilities,
      branchId: user.branchId,
      branchName: branch?.name ?? null,
      name: user.name,
      email: user.email,
      role: user.role,
    },
  };
}

// An unknown account still costs one password verification, so the response time does not reveal whether an email exists.
let decoyHash: Promise<string> | null = null;

export type LoginFailure = { ok: false; reason: "invalid_credentials" | "workspace_unavailable" };

/**
 * One sign-in attempt against the accounts that could be meant (one per hospital the person belongs to). Only ACTIVE,
 * non-system accounts with a password are candidates; an INVITED, SUSPENDED or REMOVED account is indistinguishable from
 * none. A correct password for a hospital that is not open (draft, suspended, archived) is told so - only after the
 * password proved who is asking, so a guesser learns nothing about a workspace's state.
 */
async function signInAmong(db: Db, candidates: { user: typeof users.$inferSelect; tenantStatus: string }[], password: string, remember: boolean, meta: SignInMeta) {
  if (candidates.length === 0) {
    decoyHash ??= hashPassword("decoy-password-never-matches");
    await verifyPassword(await decoyHash, password);
    return { ok: false as const, reason: "invalid_credentials" as const };
  }
  for (const c of candidates) {
    if (!c.user.passwordHash || !(await verifyPassword(c.user.passwordHash, password))) continue;
    if (!(TENANT_SIGN_IN_STATUSES as string[]).includes(c.tenantStatus)) return { ok: false as const, reason: "workspace_unavailable" as const };
    return createSessionFor(db, c.user, remember, meta);
  }
  return { ok: false as const, reason: "invalid_credentials" as const };
}

/** A person's sign-in-capable accounts for this email: open hospitals first, then the most recently used. At most five. */
async function accountCandidates(db: Db, email: string, tenantSlug?: string) {
  const conds = [eq(users.email, email), eq(users.status, "ACTIVE"), eq(users.isSystem, false)];
  if (tenantSlug !== undefined) conds.push(eq(tenants.loginSlug, tenantSlug));
  return db
    .select({ user: users, tenantStatus: tenants.status })
    .from(users)
    .innerJoin(tenants, eq(users.tenantId, tenants.id))
    .where(and(...conds))
    .orderBy(sql`(${tenants.status} in ('ACTIVE', 'ONBOARDING')) desc`, desc(sql`coalesce(${users.lastSignInAt}, ${users.createdAt})`))
    .limit(5);
}

export async function loginWithPassword(db: Db, email: string, password: string, remember = false, meta: SignInMeta = {}) {
  return signInAmong(db, await accountCandidates(db, email), password, remember, meta);
}

/**
 * Sign-in through a hospital's dedicated page. The hospital is found by the route's slug on the server and the user by
 * (that hospital, email): a person of any other hospital cannot sign in here, and a shared email resolves to THIS
 * hospital's account. An unknown slug costs the same password check as an unknown email and answers identically.
 */
export async function loginToTenant(db: Db, slug: string, email: string, password: string, remember = false, meta: SignInMeta = {}) {
  return signInAmong(db, await accountCandidates(db, email, slug), password, remember, meta);
}

/**
 * What the branded sign-in page may show, by slug: display words and one logo file. Nothing else about a hospital is public (no ids,
 * edition, users or settings). Defaults fill every gap, so a missing logo or tagline can never block a sign-in; a stored logo is
 * re-checked against the allowed shape on the way out as well as by the database.
 */
export async function getTenantBranding(db: Db, slug: string): Promise<TenantLoginBranding | null> {
  const [row] = await db
    .select({ name: tenants.name, c: tenantLoginConfigs })
    .from(tenants)
    .leftJoin(tenantLoginConfigs, eq(tenantLoginConfigs.tenantId, tenants.id))
    .where(eq(tenants.loginSlug, slug))
    .limit(1);
  if (!row) return null;
  const c = row.c;
  return {
    slug,
    displayName: row.name,
    shortName: c?.shortName ?? row.name.trim().split(/\s+/)[0] ?? row.name,
    logoPath: c?.logoPath && LOGIN_LOGO_PATH_PATTERN.test(c.logoPath) ? c.logoPath : null,
    headline: c?.headline ?? null,
    tagline: c?.tagline ?? DEFAULT_LOGIN_TAGLINE,
    badgeLabel: c?.badgeLabel ?? null,
    supportText: c?.supportText ?? DEFAULT_LOGIN_SUPPORT_TEXT,
  };
}

// Development convenience only — see auth.routes.ts for the env guard that
// decides whether this is even reachable. No password check: it exists
// specifically to skip typing one, for a fixed, non-secret set of seeded
// demo accounts, never a real credential.
export async function loginByRole(db: Db, role: Role, environment: string = DEFAULT_DEMO_ENVIRONMENT) {
  // A hospital that signed up while development login was on: found by tenant id, and only if it was made visible.
  if (environment.startsWith(DEV_TENANT_PREFIX)) return loginToDevTenant(db, role, environment.slice(DEV_TENANT_PREFIX.length));
  if (!DEMO_ENVIRONMENTS.some((e) => e.key === environment)) return { ok: false as const, reason: "no_seeded_user_for_role" as const };
  // Resolved to the environment's own seeded user: email AND tenant must both
  // match. Email alone is only unique per tenant, and "first user with this
  // role" would pick a user from an arbitrary tenant.
  const email = demoEmailForRole(environment as DemoEnvironmentKey, role);
  const tenantName = DEMO_ENVIRONMENTS.find((e) => e.key === environment)?.tenantName;
  if (!email || !tenantName) return { ok: false as const, reason: "no_seeded_user_for_role" as const };
  const [row] = await db
    .select({ user: users })
    .from(users)
    .innerJoin(tenants, eq(users.tenantId, tenants.id))
    .where(and(eq(users.email, email), eq(tenants.name, tenantName), eq(users.status, "ACTIVE"), eq(users.isSystem, false), inArray(tenants.status, TENANT_SIGN_IN_STATUSES)))
    .limit(1);
  const user = row?.user;
  if (!user) return { ok: false as const, reason: "no_seeded_user_for_role" as const };
  return createSessionFor(db, user);
}

/** Sign-in as a user who was just created by the server (sign-up). Standard session length; no password check by design. */
export async function createSessionForUserId(db: Db, userId: string, remember = false) {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new Error("createSessionForUserId: unknown user");
  return createSessionFor(db, user, remember);
}

export const DEV_TENANT_PREFIX = "tenant:";
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE_LABEL = new Map(DEMO_LOGIN_ROLES.map((r) => [r.role, r.label]));
const ROLE_ORDER = DEMO_LOGIN_ROLES.map((r) => r.role);

async function rolesInTenant(db: Db, tenantId: string): Promise<{ role: Role; label: string }[]> {
  const rows = await db.selectDistinct({ role: users.role }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.status, "ACTIVE"), eq(users.isSystem, false)));
  return rows
    .map((r) => r.role)
    .filter((r) => ROLE_LABEL.has(r))
    .sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b))
    .map((role) => ({ role, label: ROLE_LABEL.get(role)! }));
}

/**
 * Developer Access (development only): the seeded demo hospitals that exist, plus every hospital that signed up while
 * development login was enabled - each with the roles that actually have an account. Read from the database, so a new
 * sign-up appears with no code change. Only rows marked `dev_visible` are ever listed.
 */
export async function listDevEnvironments(db: Db): Promise<DevEnvironment[]> {
  const out: DevEnvironment[] = [];
  for (const env of DEMO_ENVIRONMENTS) {
    const [tenant] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.name, env.tenantName)).limit(1);
    if (!tenant) continue;
    out.push({ key: env.key, label: env.label, roles: await rolesInTenant(db, tenant.id) });
  }
  const signedUp = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenantProfiles)
    .innerJoin(tenants, eq(tenants.id, tenantProfiles.tenantId))
    .where(and(eq(tenantProfiles.devVisible, true), eq(tenantProfiles.source, "signup")))
    .orderBy(tenants.createdAt);
  for (const t of signedUp) out.push({ key: `${DEV_TENANT_PREFIX}${t.id}`, label: t.name, roles: await rolesInTenant(db, t.id) });
  return out;
}

async function loginToDevTenant(db: Db, role: Role, tenantId: string) {
  if (!TENANT_ID.test(tenantId)) return { ok: false as const, reason: "no_seeded_user_for_role" as const };
  const [visible] = await db.select({ id: tenantProfiles.tenantId }).from(tenantProfiles).where(and(eq(tenantProfiles.tenantId, tenantId), eq(tenantProfiles.devVisible, true), eq(tenantProfiles.source, "signup"))).limit(1);
  if (!visible) return { ok: false as const, reason: "no_seeded_user_for_role" as const };
  const [user] = await db
    .select({ u: users })
    .from(users)
    .innerJoin(tenants, eq(tenants.id, users.tenantId))
    .where(and(eq(users.tenantId, tenantId), eq(users.role, role), eq(users.status, "ACTIVE"), eq(users.isSystem, false), inArray(tenants.status, TENANT_SIGN_IN_STATUSES)))
    .orderBy(users.createdAt)
    .limit(1)
    .then((r) => r.map((x) => x.u));
  if (!user) return { ok: false as const, reason: "no_seeded_user_for_role" as const };
  return createSessionFor(db, user);
}

export async function resolveSession(db: Db, sessionId: string) {
  if (!SESSION_ID.test(sessionId)) return null;
  const [row] = await db
    .select({ session: sessions, user: users, branch: branches, tenantName: tenants.name, loginSlug: tenants.loginSlug, timezone: tenants.timezone, edition: tenants.edition, surfaceStyle: tenants.surfaceStyle })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .innerJoin(tenants, eq(users.tenantId, tenants.id))
    .leftJoin(branches, eq(users.branchId, branches.id))
    // Suspending an account or a hospital ends its open sessions on the very next request, not at their expiry.
    .where(and(eq(sessions.id, sessionId), eq(users.status, "ACTIVE"), eq(users.isSystem, false), inArray(tenants.status, TENANT_SIGN_IN_STATUSES)))
    .limit(1);

  if (!row) return null;
  const now = Date.now();
  if (row.session.expiresAt.getTime() < now) return null;
  // Last activity, for the Platform Console's session list: refreshed at most once a minute.
  if (now - (row.session.lastSeenAt ?? row.session.createdAt).getTime() > 60_000) await db.update(sessions).set({ lastSeenAt: new Date(now) }).where(eq(sessions.id, sessionId));

  return {
    id: row.user.id,
    tenantId: row.user.tenantId,
    tenantName: row.tenantName,
    loginSlug: row.loginSlug,
    branchId: row.user.branchId,
    branchName: row.branch?.name ?? null,
    name: row.user.name,
    email: row.user.email,
    role: row.user.role,
    timezone: row.timezone,
    surfaceStyle: toSurfaceStyle(row.surfaceStyle),
    interfaceSize: toInterfaceSize(row.user.interfaceSize),
    textSize: toTextSize(row.user.textSize),
    edition: row.edition,
    // Resolved on every request: a Super Admin's switch takes effect immediately, in the API and in the next UI refresh.
    capabilities: await resolveTenantCapabilities(db, row.user.tenantId, row.edition),
  };
}

export async function revokeSession(db: Db, sessionId: string) {
  if (!SESSION_ID.test(sessionId)) return;
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}
