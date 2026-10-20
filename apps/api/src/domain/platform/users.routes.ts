import type { FastifyInstance, FastifyRequest } from "fastify";
import { actorFromRequest } from "./audit.service.js";
import { notFound, parse, refuse } from "./http.js";
import { requirePlatform } from "./platform-guard.js";
import { platformRateLimit } from "./rate-limit.js";
import {
  addMemberSchema,
  addMembership,
  changeIdentityStatus,
  changeMembershipRole,
  changeMembershipStatus,
  changeRoleSchema,
  getUserDetail,
  listTenantMembers,
  listUsers,
  listUsersSchema,
  reasonSchema,
  revokeMembershipSessions,
  revokeTenantSession,
  sendPasswordReset,
} from "./users.service.js";
import { listInvitations, listInvitationsSchema, resendInvitation, revokeInvitation } from "./invitations.service.js";
import { changeStaffRole, changeStaffStatus, inviteStaff, inviteStaffSchema, listStaff, revokeStaffSessions, staffReasonSchema, staffRoleSchema, type StaffActor } from "./staff.service.js";

type Id = { Params: { id: string } };

function staffActor(request: FastifyRequest): StaffActor {
  return { ...actorFromRequest(request), platformUserId: request.platformUser!.id, role: request.platformUser!.role };
}

export async function platformUserRoutes(app: FastifyInstance) {
  const view = { preHandler: requirePlatform("VIEW_PLATFORM") };
  const memberships = { preHandler: requirePlatform("MANAGE_MEMBERSHIPS") };
  const access = (kind: "links" | "access") => ({ preHandler: [requirePlatform("MANAGE_ACCOUNT_ACCESS"), platformRateLimit(kind)] });

  // Directory and detail ------------------------------------------------------------------------------------------------
  app.get("/platform/users", view, async (request, reply) => {
    const q = parse(listUsersSchema, request.query, reply);
    return q ? listUsers(app.db, q) : reply;
  });
  app.get<Id>("/platform/users/:id", view, async (request, reply) => (await getUserDetail(app.db, request.params.id)) ?? notFound(reply));
  app.get<Id>("/platform/tenants/:id/members", view, async (request, reply) => (await listTenantMembers(app.db, request.params.id)) ?? notFound(reply));

  // Memberships ---------------------------------------------------------------------------------------------------------
  app.post<Id>("/platform/tenants/:id/members", memberships, async (request, reply) => {
    const body = parse(addMemberSchema, request.body, reply);
    if (!body) return reply;
    const r = await addMembership(app.db, request.params.id, body, actorFromRequest(request));
    return r.ok ? reply.status(201).send({ userId: r.userId, invitation: r.invitation }) : refuse(reply, r);
  });
  app.patch<Id>("/platform/memberships/:id", memberships, async (request, reply) => {
    const body = parse(changeRoleSchema, request.body, reply);
    if (!body) return reply;
    const r = await changeMembershipRole(app.db, request.params.id, body, actorFromRequest(request));
    return r.ok ? { ok: true } : refuse(reply, r);
  });
  for (const action of ["suspend", "reactivate", "remove"] as const) {
    app.post<Id>(`/platform/memberships/:id/${action}`, memberships, async (request, reply) => {
      const body = parse(reasonSchema, request.body, reply);
      if (!body) return reply;
      const r = await changeMembershipStatus(app.db, request.params.id, action, body, actorFromRequest(request));
      return r.ok ? { ok: true } : refuse(reply, r);
    });
  }

  // Account access (support tools): reset links and sessions. Never a visible password, never a hash. ---------------------
  app.post<Id>("/platform/memberships/:id/password-reset", access("links"), async (request, reply) => {
    const r = await sendPasswordReset(app.db, request.params.id, actorFromRequest(request));
    return r.ok ? { deliveryStatus: r.deliveryStatus } : refuse(reply, r);
  });
  app.post<Id>("/platform/memberships/:id/revoke-sessions", access("access"), async (request, reply) => {
    const r = await revokeMembershipSessions(app.db, request.params.id, actorFromRequest(request));
    return r.ok ? { revoked: r.revoked } : refuse(reply, r);
  });
  app.delete<Id>("/platform/sessions/:id", access("access"), async (request, reply) => {
    const r = await revokeTenantSession(app.db, request.params.id, actorFromRequest(request));
    return r.ok ? { ok: true } : refuse(reply, r);
  });

  // A person everywhere they are a member.
  for (const action of ["suspend", "reactivate"] as const) {
    app.post<Id>(`/platform/users/:id/${action}`, { preHandler: [requirePlatform("SUSPEND_ACCOUNTS"), platformRateLimit("access")] }, async (request, reply) => {
      const body = parse(reasonSchema, request.body, reply);
      if (!body) return reply;
      const r = await changeIdentityStatus(app.db, request.params.id, action, body, actorFromRequest(request));
      return r.ok ? { affected: r.affected } : refuse(reply, r);
    });
  }

  // Invitations -----------------------------------------------------------------------------------------------------------
  app.get("/platform/invitations", view, async (request, reply) => {
    const q = parse(listInvitationsSchema, request.query, reply);
    return q ? listInvitations(app.db, q) : reply;
  });
  app.post<Id>("/platform/invitations/:id/resend", access("links"), async (request, reply) => {
    const r = await resendInvitation(app.db, request.params.id, actorFromRequest(request));
    return r.ok ? { invitation: r.invitation } : refuse(reply, r);
  });
  app.post<Id>("/platform/invitations/:id/revoke", access("access"), async (request, reply) => {
    const body = parse(staffReasonSchema, request.body, reply);
    if (!body) return reply;
    const r = await revokeInvitation(app.db, request.params.id, body.reason, actorFromRequest(request));
    return r.ok ? { ok: true } : refuse(reply, r);
  });

  // Platform staff --------------------------------------------------------------------------------------------------------
  const staff = { preHandler: [requirePlatform("MANAGE_PLATFORM_STAFF"), platformRateLimit("access")] };
  app.get("/platform/staff", view, async () => ({ staff: await listStaff(app.db) }));
  app.post("/platform/staff", staff, async (request, reply) => {
    const body = parse(inviteStaffSchema, request.body, reply);
    if (!body) return reply;
    const r = await inviteStaff(app.db, body, staffActor(request));
    return r.ok ? reply.status(201).send({ id: r.id, invitation: r.invitation }) : refuse(reply, r);
  });
  app.patch<Id>("/platform/staff/:id", staff, async (request, reply) => {
    const body = parse(staffRoleSchema, request.body, reply);
    if (!body) return reply;
    const r = await changeStaffRole(app.db, request.params.id, body, staffActor(request));
    return r.ok ? { ok: true } : refuse(reply, r);
  });
  for (const action of ["suspend", "reactivate"] as const) {
    app.post<Id>(`/platform/staff/:id/${action}`, staff, async (request, reply) => {
      const body = parse(staffReasonSchema, request.body, reply);
      if (!body) return reply;
      const r = await changeStaffStatus(app.db, request.params.id, action, body.reason, staffActor(request));
      return r.ok ? { ok: true } : refuse(reply, r);
    });
  }
  // Ending console sessions: your own always; anyone else's needs MANAGE_PLATFORM_STAFF over their role (checked in the service).
  app.post<{ Params: { id: string }; Body: { sessionId?: string } }>("/platform/staff/:id/revoke-sessions", { preHandler: [requirePlatform("VIEW_PLATFORM"), platformRateLimit("access")] }, async (request, reply) => {
    const sessionId = typeof (request.body as { sessionId?: unknown } | null)?.sessionId === "string" ? (request.body as { sessionId: string }).sessionId : null;
    if (request.params.id !== request.platformUser!.id && !request.platformUser!.permissions.includes("MANAGE_PLATFORM_STAFF")) return reply.status(403).send({ error: "forbidden" });
    const r = await revokeStaffSessions(app.db, request.params.id, sessionId, staffActor(request));
    return r.ok ? { revoked: r.revoked } : refuse(reply, r);
  });
}
