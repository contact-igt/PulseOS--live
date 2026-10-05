import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createSessionForUserId, DEV_TENANT_PREFIX, getTenantBranding, listDevEnvironments, loginByRole, loginToTenant, loginWithPassword, revokeSession } from "./auth.service.js";
import { signUpHospital, signupSchema } from "./signup.service.js";
import { LoginThrottle } from "./login-throttle.js";
import { DEFAULT_DEMO_ENVIRONMENT, DEMO_ENVIRONMENTS, DEMO_LOGIN_ROLES } from "./demo-environments.js";

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  remember: z.boolean().optional(),
});

// A hospital's dedicated sign-in: the body is strict, so a tenant id (or anything else) smuggled in is refused, never honoured.
const tenantLoginBody = loginBody.strict();
const SLUG = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;

const SESSION_COOKIE = "pulseos_session";

// Evaluated once, at route-registration time (buildApp), not per-request —
// so in production, or with the flag off, these routes don't exist at all
// rather than existing and 403ing. NODE_ENV !== "production" alone is not
// enough: every local/staging box already runs non-production, so the
// second, explicit opt-in flag is what actually keeps this off by default.
function devLoginEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.ENABLE_DEV_LOGIN === "true";
}

const devLoginBody = z.object({
  role: z.enum(["SUPER_ADMIN", "HOSPITAL_ADMIN", "FRONT_DESK", "PATIENT_COORDINATOR", "DOCTOR"]),
  // A seeded demo environment key, or "tenant:<uuid>" for a hospital that signed up (checked again server-side).
  environment: z
    .string()
    .refine((v) => DEMO_ENVIRONMENTS.some((e) => e.key === v) || DEV_TENANT_ENV.test(v), "unknown environment")
    .optional(),
});

const DEV_TENANT_ENV = new RegExp("^" + DEV_TENANT_PREFIX + "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" + String.fromCharCode(36), "i");

/** In-memory sign-up throttle per address: a public form must not be a free tenant factory. */
class SignupLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly windowMs = 60 * 60 * 1000) {}
  allow(ip: string, now = Date.now()): boolean {
    const recent = (this.hits.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(ip, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(ip, recent);
    return true;
  }
}

function setSessionCookie(reply: import("fastify").FastifyReply, sessionId: string, expiresAt: Date, persistent = true) {
  reply.setCookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    // A session cookie (no expiry) unless the person asked to be remembered; the server-side session expires either way.
    ...(persistent ? { expires: expiresAt } : {}),
  });
}

/** The caller is the same machine (IPv4/IPv6 loopback, or IPv4-mapped IPv6). */
function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export async function authRoutes(app: FastifyInstance) {
  // Failed sign-ins are throttled per account+address and per address (see login-throttle.ts). Limits are env-tunable.
  const num = (v: string | undefined) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
  const throttle = new LoginThrottle({ maxPerAccount: num(process.env.LOGIN_MAX_FAILURES), maxPerAddress: num(process.env.LOGIN_MAX_FAILURES_PER_ADDRESS), windowMs: num(process.env.LOGIN_LOCK_WINDOW_MS) });

  app.post("/auth/login", async (request, reply) => {
    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request" });
    }

    // The attempt is admitted and counted BEFORE the slow password check (so parallel guesses cannot all slip through),
    // and a lock is answered identically whether or not the account exists.
    const gate = throttle.begin(request.ip, parsed.data.email);
    if (!gate.allowed) {
      return reply.header("Retry-After", String(gate.retryAfterSeconds)).status(429).send({ error: "too_many_attempts", message: "Too many sign-in attempts. Please wait a few minutes and try again." });
    }

    const result = await loginWithPassword(app.db, parsed.data.email, parsed.data.password, parsed.data.remember === true);
    if (!result.ok) {
      return reply.status(401).send({ error: result.reason });
    }
    throttle.succeed(request.ip, parsed.data.email);

    setSessionCookie(reply, result.sessionId, result.expiresAt, result.remember);
    return reply.send({ user: result.user });
  });

  // The dedicated hospital sign-in page (e.g. /login/namokar). Same session, same checks, same throttle - but the hospital is
  // fixed by the route, so there is nothing to choose and no way to reach another hospital from here.
  app.get("/auth/tenants/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const branding = SLUG.test(slug) ? await getTenantBranding(app.db, slug) : null;
    if (!branding) return reply.status(404).send({ error: "not_found" });
    return reply.send(branding);
  });

  app.post("/auth/login/tenant/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const parsed = tenantLoginBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });

    const account = `${slug}:${parsed.data.email}`;
    const gate = throttle.begin(request.ip, account);
    if (!gate.allowed) {
      return reply.header("Retry-After", String(gate.retryAfterSeconds)).status(429).send({ error: "too_many_attempts", message: "Too many sign-in attempts. Please wait a few minutes and try again." });
    }
    const result = SLUG.test(slug) ? await loginToTenant(app.db, slug, parsed.data.email, parsed.data.password, parsed.data.remember === true) : ({ ok: false, reason: "invalid_credentials" } as const);
    if (!result.ok) return reply.status(401).send({ error: result.reason });
    throttle.succeed(request.ip, account);

    setSessionCookie(reply, result.sessionId, result.expiresAt, result.remember);
    return reply.send({ user: result.user });
  });

  // Public hospital sign-up. The server creates the tenant and its first Super Admin; the body can never name a tenant.
  const signupLimiter = new SignupLimiter(num(process.env.SIGNUP_MAX_PER_HOUR) ?? 10);
  app.post("/auth/signup", async (request, reply) => {
    if (!signupLimiter.allow(request.ip)) return reply.header("Retry-After", "3600").status(429).send({ error: "too_many_signups", message: "Too many sign-ups from this address. Please try again later." });
    const parsed = signupSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    const result = await signUpHospital(app.db, parsed.data, { devVisible: devLoginEnabled() });
    if (!result.ok) return reply.status(result.reason === "email_in_use" ? 409 : 400).send({ error: result.reason });
    const session = await createSessionForUserId(app.db, result.userId, false);
    setSessionCookie(reply, session.sessionId, session.expiresAt, false);
    return reply.status(201).send({ user: session.user, workspace: { template: result.template, loginPath: `/login/${result.loginSlug}` } });
  });

  // Development-only convenience — see devLoginEnabled() above. Registered
  // conditionally so these two routes simply don't exist unless explicitly
  // opted into outside production, never merely permission-gated.
  if (devLoginEnabled()) {
    app.get("/auth/dev-login/roles", async (_request, reply) => {
      // Only roles with an actual seeded demo account belong here (there's
      // no seeded SUPER_ADMIN, so it's deliberately absent).
      return reply.send(DEMO_LOGIN_ROLES.map(({ role, label }) => ({ role, label })));
    });

    // Read from the database, so a hospital that signs up appears here with no code change.
    app.get("/auth/dev-login/environments", async (_request, reply) => {
      return reply.send(await listDevEnvironments(app.db));
    });

    app.post("/auth/dev-login", async (request, reply) => {
      // Passwordless: only ever answers the machine it runs on, whatever the environment flags say.
      if (!isLoopback(request.ip)) return reply.status(403).send({ error: "dev_login_local_only" });
      const parsed = devLoginBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "invalid_request" });
      }

      const result = await loginByRole(app.db, parsed.data.role, parsed.data.environment ?? DEFAULT_DEMO_ENVIRONMENT);
      if (!result.ok) {
        return reply.status(404).send({ error: result.reason });
      }

      setSessionCookie(reply, result.sessionId, result.expiresAt, false);
      return reply.send({ user: result.user });
    });
  }

  app.post("/auth/logout", async (request, reply) => {
    const sessionId = request.cookies[SESSION_COOKIE];
    if (sessionId) {
      await revokeSession(app.db, sessionId);
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.send({ ok: true });
  });

  app.get("/auth/session", async (request, reply) => {
    if (!request.sessionUser) {
      return reply.status(401).send({ error: "unauthenticated" });
    }
    return reply.send({ user: request.sessionUser });
  });
}

export { SESSION_COOKIE };
