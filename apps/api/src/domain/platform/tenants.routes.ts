import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorFromRequest } from "./audit.service.js";
import { DEPARTMENT_TEMPLATES } from "../specialty/department-templates.js";
import { notFound, parse, refuse } from "./http.js";
import { requirePlatform } from "./platform-guard.js";
import {
  UUID,
  appearanceSchema,
  branchSchema,
  brandingSchema,
  changeTenantConfiguration,
  changeTenantLifecycle,
  createTenant,
  createTenantSchema,
  departmentInstallSchema,
  departmentUpdateSchema,
  editTenant,
  editTenantSchema,
  getTenantConfiguration,
  getTenantDetail,
  getTenantUsage,
  leadSourceCreateSchema,
  leadSourceUpdateSchema,
  lifecycleSchema,
  listTenants,
  listTenantsSchema,
  saveTenantAppearance,
  saveTenantBranding,
  setPrimaryAdmin,
  tenantIndustries,
} from "./tenants.service.js";

type IdParams = { id: string };

export async function platformTenantRoutes(app: FastifyInstance) {
  const view = { preHandler: requirePlatform("VIEW_PLATFORM") };
  const edit = { preHandler: requirePlatform("EDIT_TENANT") };

  app.get("/platform/tenants", view, async (request, reply) => {
    const q = parse(listTenantsSchema, request.query, reply);
    if (!q) return reply;
    return listTenants(app.db, q);
  });

  app.get("/platform/tenants/industries", view, async () => ({ industries: await tenantIndustries(app.db) }));
  // Global, read-only product templates a new tenant can start from (installing one copies it into tenant-owned rows).
  app.get("/platform/department-templates", view, async () => ({ templates: DEPARTMENT_TEMPLATES.map((t) => ({ key: t.key, displayName: t.displayName, description: t.description })) }));

  app.post("/platform/tenants", { preHandler: requirePlatform("CREATE_TENANT") }, async (request, reply) => {
    const body = parse(createTenantSchema, request.body, reply);
    if (!body) return reply;
    const r = await createTenant(app.db, body, actorFromRequest(request));
    if (!r.ok) return refuse(reply, r);
    return reply.status(r.created ? 201 : 200).send({ tenant: r.tenant, invitation: r.invitation, created: r.created });
  });

  app.get<{ Params: IdParams }>("/platform/tenants/:id", view, async (request, reply) => {
    const detail = await getTenantDetail(app.db, request.params.id);
    return detail ?? notFound(reply);
  });

  app.patch<{ Params: IdParams }>("/platform/tenants/:id", edit, async (request, reply) => {
    if (!UUID.test(request.params.id)) return notFound(reply);
    const body = parse(editTenantSchema, request.body, reply);
    if (!body) return reply;
    const r = await editTenant(app.db, request.params.id, body, actorFromRequest(request));
    return r.ok ? { tenant: r.tenant } : refuse(reply, r);
  });

  app.post<{ Params: IdParams }>("/platform/tenants/:id/lifecycle", { preHandler: requirePlatform("MANAGE_TENANT_LIFECYCLE") }, async (request, reply) => {
    if (!UUID.test(request.params.id)) return notFound(reply);
    const body = parse(lifecycleSchema, request.body, reply);
    if (!body) return reply;
    const r = await changeTenantLifecycle(app.db, request.params.id, body, actorFromRequest(request));
    return r.ok ? { tenant: r.tenant } : refuse(reply, r);
  });

  app.put<{ Params: IdParams }>("/platform/tenants/:id/branding", edit, async (request, reply) => {
    const body = parse(brandingSchema, request.body, reply);
    if (!body) return reply;
    const r = await saveTenantBranding(app.db, request.params.id, body, actorFromRequest(request));
    return r.ok ? { ok: true } : refuse(reply, r);
  });

  app.put<{ Params: IdParams }>("/platform/tenants/:id/appearance", edit, async (request, reply) => {
    const body = parse(appearanceSchema, request.body, reply);
    if (!body) return reply;
    const r = await saveTenantAppearance(app.db, request.params.id, body, actorFromRequest(request));
    return r.ok ? { ok: true } : refuse(reply, r);
  });

  app.put<{ Params: IdParams }>("/platform/tenants/:id/primary-admin", { preHandler: requirePlatform("MANAGE_MEMBERSHIPS") }, async (request, reply) => {
    const body = parse(z.object({ userId: z.string() }).strict(), request.body, reply);
    if (!body) return reply;
    const r = await setPrimaryAdmin(app.db, request.params.id, body.userId, actorFromRequest(request));
    return r.ok ? { ok: true } : refuse(reply, r);
  });

  app.get<{ Params: IdParams }>("/platform/tenants/:id/configuration", view, async (request, reply) => {
    const cfg = await getTenantConfiguration(app.db, request.params.id);
    return cfg ?? notFound(reply);
  });

  app.get<{ Params: IdParams }>("/platform/tenants/:id/usage", view, async (request, reply) => {
    const usage = await getTenantUsage(app.db, request.params.id);
    return usage ?? notFound(reply);
  });

  // Configuration help: branches, departments, lead sources (the same services the hospital's own Settings use).
  type Params = Record<string, string>;
  const configRoute = (method: "POST" | "PATCH", url: string, schema: z.ZodTypeAny, build: (params: Params, input: never) => Parameters<typeof changeTenantConfiguration>[2]) =>
    app.route<{ Params: Params }>({
      method,
      url,
      preHandler: requirePlatform("EDIT_TENANT"),
      handler: async (request, reply) => {
        const body = parse(schema, request.body, reply);
        if (!body) return reply;
        const r = await changeTenantConfiguration(app.db, request.params.id ?? "", build(request.params, body as never), actorFromRequest(request));
        return r.ok ? reply.status(method === "POST" ? 201 : 200).send({ ok: true }) : refuse(reply, r);
      },
    });
  configRoute("POST", "/platform/tenants/:id/branches", branchSchema, (_p, input) => ({ kind: "branch.create", input }));
  configRoute("PATCH", "/platform/tenants/:id/branches/:branchId", branchSchema, (p, input) => ({ kind: "branch.update", branchId: p.branchId ?? "", input }));
  configRoute("POST", "/platform/tenants/:id/departments", departmentInstallSchema, (_p, input) => ({ kind: "department.install", input }));
  configRoute("PATCH", "/platform/tenants/:id/departments/:departmentId", departmentUpdateSchema, (p, input) => ({ kind: "department.update", departmentId: p.departmentId ?? "", input }));
  configRoute("POST", "/platform/tenants/:id/lead-sources", leadSourceCreateSchema, (_p, input) => ({ kind: "lead_source.create", input }));
  configRoute("PATCH", "/platform/tenants/:id/lead-sources/:sourceId", leadSourceUpdateSchema, (p, input) => ({ kind: "lead_source.update", sourceId: p.sourceId ?? "", input }));
}
