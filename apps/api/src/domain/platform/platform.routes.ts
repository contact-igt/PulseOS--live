import type { FastifyInstance } from "fastify";
import { requirePlatform } from "./platform-guard.js";
import { getPlatformOverview } from "./overview.service.js";
import { platformTenantRoutes } from "./tenants.routes.js";
import { platformUserRoutes } from "./users.routes.js";
import { platformPlanRoutes } from "./plans.routes.js";
import { platformIntegrationRoutes } from "./integrations.routes.js";
import { platformSupportRoutes } from "./support.routes.js";
import { platformOpsRoutes } from "./ops.routes.js";

/**
 * The Platform Console API. Every route here names its own platform permission (requirePlatform); the app-level hook has
 * already refused any request without a platform session. Tenant sessions never reach these handlers.
 */
export async function platformRoutes(app: FastifyInstance) {
  app.get("/platform/overview", { preHandler: requirePlatform("VIEW_PLATFORM") }, async () => getPlatformOverview(app.db));
  await app.register(platformTenantRoutes);
  await app.register(platformUserRoutes);
  await app.register(platformPlanRoutes);
  await app.register(platformIntegrationRoutes);
  await app.register(platformSupportRoutes);
  await app.register(platformOpsRoutes);
}
