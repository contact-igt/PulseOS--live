import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { DEFAULT_LOGIN_SUPPORT_TEXT, DEFAULT_LOGIN_TAGLINE, type TenantLoginBranding } from "@pulseos/types";
import { buildApp } from "../app.js";
import { db, queryClient } from "../db/client.js";
import { tenantLoginConfigs, tenants } from "../db/schema.js";
import { createTestTenant, destroyTestTenant, type TestTenant } from "./helpers/edition-tenant.js";

process.env.SIGNUP_MAX_PER_HOUR = "1000";
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;

// One approved PulseOS sign-in page for every hospital; only SAFE structured data differs. The public branding endpoint is
// the whole boundary: it returns display fields and nothing else.
describe.skipIf(!DEMO_PASSWORD)("tenant sign-in branding (integration)", () => {
  let app: FastifyInstance;
  let t: TestTenant;
  const slug = `brand-${randomUUID().slice(0, 8)}`;
  const branding = async (s: string) => app.inject({ method: "GET", url: `/auth/tenants/${s}` });
  const createdByEmail: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    t = await createTestTenant(db, app, "BETA_V1_CORE", DEMO_PASSWORD!);
    await db.update(tenants).set({ loginSlug: slug, name: "Sunrise Eye & Laser Centre" }).where(eq(tenants.id, t.tenantId));
  });
  afterAll(async () => {
    for (const email of createdByEmail) {
      const rows = await queryClient`select distinct tenant_id from users where email = ${email}`;
      for (const r of rows) {
        const tenantId = r.tenant_id as string;
        await queryClient`delete from sessions where user_id in (select id from users where tenant_id = ${tenantId})`;
        await queryClient`delete from tenant_profiles where tenant_id = ${tenantId}`;
        await destroyTestTenant(db, { tenantId } as TestTenant);
      }
    }
    await destroyTestTenant(db, t);
    await app.close();
    await queryClient.end();
  });

  it("with no configuration, a hospital still gets a complete page from sensible defaults (no logo, no badge)", async () => {
    const res = await branding(slug);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      slug,
      displayName: "Sunrise Eye & Laser Centre",
      shortName: "Sunrise",
      logoPath: null,
      headline: null,
      tagline: DEFAULT_LOGIN_TAGLINE,
      badgeLabel: null,
      supportText: DEFAULT_LOGIN_SUPPORT_TEXT,
    } satisfies TenantLoginBranding);
  });

  it("returns exactly the display fields: no ids, edition, secrets, users or integration settings", async () => {
    await db.insert(tenantLoginConfigs).values({ tenantId: t.tenantId, shortName: "Sunrise", tagline: "Eyes first.", badgeLabel: "V1 Pilot" }).onConflictDoNothing();
    const res = await branding(slug);
    expect(Object.keys(res.json()).sort()).toEqual(["badgeLabel", "displayName", "headline", "logoPath", "shortName", "slug", "supportText", "tagline"]);
    const body = res.body;
    expect(body).not.toContain(t.tenantId);
    for (const userId of Object.values(t.userIds)) expect(body).not.toContain(userId!);
    expect(body).not.toMatch(/edition|BETA_V|capabilit|connector|secret|token|password|email|branch/i);
  });

  it("uses the hospital's own configured words and badge", async () => {
    await db.update(tenantLoginConfigs).set({ shortName: "Sunrise", headline: "Sunrise Eye & Laser Centre, Pune", tagline: "Eyes first.", badgeLabel: "V1 Pilot", supportText: "Need help? Call the front desk." }).where(eq(tenantLoginConfigs.tenantId, t.tenantId));
    expect((await branding(slug)).json()).toMatchObject({ shortName: "Sunrise", headline: "Sunrise Eye & Laser Centre, Pune", tagline: "Eyes first.", badgeLabel: "V1 Pilot", supportText: "Need help? Call the front desk." });
  });

  it("accepts a logo only as a file of this app's own /brand folder, and refuses anything that could carry script or an outside URL", async () => {
    await db.update(tenantLoginConfigs).set({ logoPath: "/brand/sunrise.svg" }).where(eq(tenantLoginConfigs.tenantId, t.tenantId));
    expect((await branding(slug)).json().logoPath).toBe("/brand/sunrise.svg");
    for (const bad of ["https://evil.example/x.svg", "//evil.example/x.svg", "javascript:alert(1)", "/brand/../secret.svg", "/brand/x.svg?x=<script>", "data:image/svg+xml;base64,AAAA", "/other/logo.svg", "/brand/logo.html", "/brand/"]) {
      await expect(db.update(tenantLoginConfigs).set({ logoPath: bad }).where(eq(tenantLoginConfigs.tenantId, t.tenantId)), bad).rejects.toThrow();
    }
    await db.update(tenantLoginConfigs).set({ logoPath: null }).where(eq(tenantLoginConfigs.tenantId, t.tenantId));
  });

  it("limits every text field, so a page can never be flooded or turned into a banner", async () => {
    for (const set of [{ shortName: "x".repeat(41) }, { headline: "x".repeat(121) }, { tagline: "x".repeat(161) }, { badgeLabel: "x".repeat(25) }, { supportText: "x".repeat(161) }]) {
      await expect(db.update(tenantLoginConfigs).set(set).where(eq(tenantLoginConfigs.tenantId, t.tenantId)), JSON.stringify(set).slice(0, 30)).rejects.toThrow();
    }
  });

  it("an unknown or malformed name is a plain 404 that reveals nothing", async () => {
    for (const s of ["no-such-workspace", "NAMOKAR-X", "a", "x".repeat(60), "bad slug", t.tenantId]) {
      const res = await branding(encodeURIComponent(s));
      expect(res.statusCode, s).toBe(404);
      expect(res.json()).toEqual({ error: "not_found" });
    }
    // Path tricks never reach a hospital: whatever the framework answers, it is an error with no hospital information in it.
    for (const s of ["..", "%00", "%2e%2e", "namokar%2f..%2f"]) {
      const res = await branding(s);
      expect([400, 404], s).toContain(res.statusCode);
      expect(res.body).not.toMatch(/displayName|tenant|slug":"[a-z]/i);
    }
  });

  it("Remember me: ON is a persistent cookie for 7 days, OFF is a session cookie; the sign-in itself is unchanged", async () => {
    const email = `remember-${randomUUID().slice(0, 6)}@brand-test.local`;
    const { users } = await import("../db/schema.js");
    const { hashPassword } = await import("../domain/auth/auth.service.js");
    await db.insert(users).values({ tenantId: t.tenantId, branchId: t.branchId, name: "Remember Tester", email, passwordHash: await hashPassword("Remember-9-pw"), role: "FRONT_DESK" });
    const login = (remember: boolean) => app.inject({ method: "POST", url: `/auth/login/tenant/${slug}`, payload: { email, password: "Remember-9-pw", remember } });

    const on = await login(true);
    expect(on.statusCode).toBe(200);
    const onCookie = on.cookies.find((c) => c.name === "pulseos_session")!;
    expect(onCookie).toMatchObject({ httpOnly: true, sameSite: "Lax" });
    const days = (new Date(onCookie.expires!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7.01);

    const off = await login(false);
    const offCookie = off.cookies.find((c) => c.name === "pulseos_session")!;
    expect(offCookie.expires).toBeUndefined(); // ends with the browser session; the server session is 12 hours
    const [{ hours }] = (await queryClient`select extract(epoch from (s.expires_at - now()))/3600 as hours from sessions s where s.id = ${offCookie.value}`) as unknown as { hours: number }[];
    expect(Number(hours)).toBeLessThan(12.1);
    const [{ days: serverDays }] = (await queryClient`select extract(epoch from (s.expires_at - now()))/86400 as days from sessions s where s.id = ${onCookie.value}`) as unknown as { days: number }[];
    expect(Number(serverDays)).toBeGreaterThan(6.9);
  });

  describe("a hospital that signs up gets its own sign-in page with no engineering step", () => {
    const signup = (email: string, name: string) =>
      app.inject({
        method: "POST",
        url: "/auth/signup",
        payload: { fullName: "Asha Verma", email, phone: "+91 98765 43210", password: "Correct-Horse-9", organizationName: name, industry: "Healthcare", organizationType: "Eye Hospital", department: "Ophthalmology", addressLine: "12 MG Road", city: "Bengaluru", state: "Karnataka", pinCode: "560038", country: "India", discoverySource: "Google", edition: "V1" },
      });
    const tag = Date.now().toString(36);

    it("generates a clean slug from the name, answers at /login/<slug>, and shows the hospital's own name", async () => {
      const email = `brand.${tag}.a@example.test`;
      createdByEmail.push(email);
      const res = await signup(email, `ABC Eye Hospital ${tag}`);
      expect(res.statusCode).toBe(201);
      const loginPath = res.json().workspace.loginPath as string;
      expect(loginPath).toMatch(/^\/login\/abc-eye-hospital-[a-z0-9]+$/);
      const b = await branding(loginPath.replace("/login/", ""));
      expect(b.statusCode).toBe(200);
      expect(b.json()).toMatchObject({ displayName: `ABC Eye Hospital ${tag}`, logoPath: null, tagline: DEFAULT_LOGIN_TAGLINE });
      // No badge is invented for a hospital whose configuration does not say so.
      expect(b.json().badgeLabel).toBeNull();
      // …and the owner can sign in through it.
      const signedIn = await app.inject({ method: "POST", url: `/auth/login/tenant/${loginPath.replace("/login/", "")}`, payload: { email, password: "Correct-Horse-9" } });
      expect(signedIn.statusCode).toBe(200);
    });

    it("two hospitals with the same name get different pages, and a reserved word is never a slug", async () => {
      const a = `brand.${tag}.b@example.test`;
      const b = `brand.${tag}.c@example.test`;
      const c = `brand.${tag}.d@example.test`;
      createdByEmail.push(a, b, c);
      const first = (await signup(a, `Twin Clinic ${tag}`)).json().workspace.loginPath as string;
      const second = (await signup(b, `Twin Clinic ${tag}`)).json().workspace.loginPath as string;
      expect(first).not.toBe(second);
      const reserved = (await signup(c, "Admin")).json().workspace.loginPath as string;
      expect(reserved).not.toBe("/login/admin");
      expect(reserved).toMatch(/^\/login\/[a-z][a-z0-9-]+[a-z0-9]$/);
    });

    it.skipIf(process.env.ENABLE_DEV_LOGIN !== "true")("and Developer Access (development only) discovers it by itself", async () => {
      const email = `brand.${tag}.e@example.test`;
      createdByEmail.push(email);
      const res = await signup(email, `Discoverable Clinic ${tag}`);
      expect(res.statusCode).toBe(201);
      const envs = (await app.inject({ method: "GET", url: "/auth/dev-login/environments" })).json() as { key: string; label: string }[];
      expect(envs.some((e) => e.label === `Discoverable Clinic ${tag}`)).toBe(true);
    });
  });
});
