import { activityRoutes } from "./domain/activity/activity.routes.js";
import { notificationRoutes } from "./domain/notification/notification.routes.js";
import { integrationHubRoutes } from "./domain/integration/hub.routes.js";
import { registerNotificationConsumers } from "./domain/notification/consumers.js";
import { registerIntegrationConsumers } from "./domain/integration/consumers.js";
import { capabilityRoutes } from "./domain/capability/capability.routes.js";
import Fastify, { type FastifyError, type FastifyServerOptions } from "fastify";
import cookie from "@fastify/cookie";
import { db } from "./db/client.js";
import { parseTrustProxy } from "./lib/trust-proxy.js";
import { resolveSession } from "./domain/auth/auth.service.js";
import { authRoutes, SESSION_COOKIE } from "./domain/auth/auth.routes.js";
import { dashboardRoutes } from "./domain/dashboard/dashboard.routes.js";
import { doctorDashboardRoutes } from "./domain/dashboard/doctor.routes.js";
import { patientRoutes } from "./domain/patient/patient.routes.js";
import { journeyRoutes } from "./domain/journey/journey.routes.js";
import { outcomeRoutes } from "./domain/consultation/outcome.routes.js";
import { lookupRoutes } from "./domain/lookup/lookup.routes.js";
import { clinicHoursRoutes } from "./domain/lookup/clinic-hours.routes.js";
import { appearanceRoutes } from "./domain/lookup/appearance.routes.js";
import { preferencesRoutes } from "./domain/auth/preferences.routes.js";
import { taskRoutes } from "./domain/task/task.routes.js";
import { followUpTypeRoutes } from "./domain/task/followup-type.routes.js";
import { resourceRoutes } from "./domain/resource/resource.routes.js";
import { appointmentRoutes } from "./domain/appointment/appointment.routes.js";
import { treatmentRoutes } from "./domain/treatment/treatment.routes.js";
import { conversationRoutes } from "./domain/conversation/conversation.routes.js";
import { connectorRoutes, communicationEndpointReadRoutes } from "./domain/connector/connector.routes.js";
import { callRoutes } from "./domain/call/call.routes.js";
import { webhookRoutes } from "./domain/connector/webhook.routes.js";
import { leadRoutes } from "./domain/lead/lead.routes.js";
import { specialtyRoutes } from "./domain/specialty/specialty.routes.js";
import { departmentRoutes } from "./domain/specialty/department.routes.js";
import { leadSourceRoutes } from "./domain/lead/lead-source.routes.js";
import { crmFieldRoutes } from "./domain/crm/crm-field.routes.js";
import { crmOutcomeRoutes } from "./domain/crm/crm-outcome.routes.js";
import { crmAllocationRoutes } from "./domain/crm/crm-allocation.routes.js";
import { conversationSummaryRoutes } from "./domain/conversation/summary/conversation-summary.routes.js";
import { campaignRoutes } from "./domain/campaign/campaign.routes.js";
import { analyticsRoutes } from "./domain/analytics/analytics.routes.js";
import { websiteFormRoutes } from "./domain/acquisition/website-form.routes.js";
import { reportRoutes } from "./domain/report/report.routes.js";

export async function buildApp() {
  // Behind a reverse proxy set TRUST_PROXY=<number of proxy hops> (usually 1) so request.ip is the client's address — the
  // sign-in throttle keys on it. Unset trusts no proxy: all clients then share the proxy's address.
  const options: FastifyServerOptions = {
    logger: true,
    // Fastify accepts a hop count at runtime (proxy-addr); its type declaration omits `number`.
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY) as FastifyServerOptions["trustProxy"],
  };
  const app = Fastify(options);

  // Unexpected failures are logged in full server-side but answered with a
  // generic body — a raw error message (e.g. a failed SQL query with table
  // names and ids) must never reach the browser. Expected 4xx errors keep
  // their specific, non-sensitive Fastify codes/messages.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, "unhandled error");
      return reply.status(status).send({ error: "internal_error" });
    }
    return reply.status(status).send({ statusCode: status, code: error.code, error: error.name, message: error.message });
  });

  app.decorate("db", db);

  await app.register(cookie);

  app.decorateRequest("sessionUser", null);

  app.addHook("onRequest", async (request) => {
    const sessionId = request.cookies[SESSION_COOKIE];
    if (!sessionId) return;
    request.sessionUser = await resolveSession(app.db, sessionId);
  });

  // CSRF: the session cookie is SameSite=Lax, which still travels with same-site requests from a sibling subdomain or
  // port. So a state-changing request must also come from the app's own origin. A request carrying neither Origin nor
  // Sec-Fetch-Site is not a browser (server-to-server, scripts, tests) and is not a CSRF vector. Provider webhooks and
  // the public website form are cross-origin by design and authenticate themselves.
  const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
  const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  app.addHook("onRequest", async (request, reply) => {
    if (!UNSAFE_METHODS.has(request.method)) return;
    const path = request.url.split("?")[0] ?? "";
    if (path.startsWith("/webhooks/") || path.startsWith("/forms/website/")) return;
    const origin = request.headers.origin;
    const fetchSite = request.headers["sec-fetch-site"];
    const foreign = origin !== undefined ? origin !== webOrigin : fetchSite === "cross-site" || fetchSite === "same-site";
    if (foreign) return reply.status(403).send({ error: "cross_origin_request_blocked" });
  });

  // Standard response hardening. The API only serves JSON (and audio streams that set their own type), so it can say
  // "never frame me, never sniff me, load nothing" without affecting the Next.js app that calls it. Authenticated
  // responses are never cached by a shared proxy or the browser's back/forward cache.
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    if (request.sessionUser && !reply.hasHeader("Cache-Control")) reply.header("Cache-Control", "private, no-store");
    return payload;
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("Access-Control-Allow-Origin", webOrigin);
    reply.header("Access-Control-Allow-Credentials", "true");
    reply.header("Access-Control-Allow-Headers", "content-type");
    reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    if (request.method === "OPTIONS") {
      reply.status(204).send();
    }
  });

  function requireAuth(request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply, done: () => void) {
    if (!request.sessionUser) {
      reply.status(401).send({ error: "unauthenticated" });
      return;
    }
    done();
  }

  await app.register(authRoutes);
  await app.register(webhookRoutes);
  await app.register(websiteFormRoutes);
  await app.register(async (protectedApp) => {
    protectedApp.addHook("preHandler", (request, reply, done) => requireAuth(request, reply, done));
    await protectedApp.register(dashboardRoutes);
    await protectedApp.register(doctorDashboardRoutes);
    await protectedApp.register(patientRoutes);
    await protectedApp.register(journeyRoutes);
    await protectedApp.register(outcomeRoutes);
    await protectedApp.register(lookupRoutes);
    await protectedApp.register(clinicHoursRoutes);
    await protectedApp.register(appearanceRoutes);
    await protectedApp.register(preferencesRoutes);
    await protectedApp.register(taskRoutes);
    await protectedApp.register(followUpTypeRoutes);
    await protectedApp.register(resourceRoutes);
    await protectedApp.register(appointmentRoutes);
    await protectedApp.register(treatmentRoutes);
    await protectedApp.register(conversationRoutes);
    await protectedApp.register(connectorRoutes);
    await protectedApp.register(communicationEndpointReadRoutes);
    await protectedApp.register(callRoutes);
    await protectedApp.register(leadRoutes);
    await protectedApp.register(specialtyRoutes);
    await protectedApp.register(departmentRoutes);
    await protectedApp.register(leadSourceRoutes);
    await protectedApp.register(crmFieldRoutes);
    await protectedApp.register(crmOutcomeRoutes);
    await protectedApp.register(crmAllocationRoutes);
    await protectedApp.register(conversationSummaryRoutes);
    await protectedApp.register(campaignRoutes);
    await protectedApp.register(analyticsRoutes);
    await protectedApp.register(reportRoutes);
    await protectedApp.register(capabilityRoutes);
    await protectedApp.register(integrationHubRoutes);
    await protectedApp.register(notificationRoutes);
    await protectedApp.register(activityRoutes);
  });

  registerIntegrationConsumers(app.db);
  registerNotificationConsumers(app.db);

  app.get("/health", async () => ({ ok: true }));

  return app;
}
