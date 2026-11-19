import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { canCreateHospitalTeamRole, HOSPITAL_TEAM_ROLES } from "@pulseos/types";
import { branches, users } from "../../db/schema.js";
import { recordActivity } from "../activity/activity.service.js";
import { hashPassword } from "../auth/auth.service.js";
import { requirePermission } from "../auth/permission.middleware.js";
import { lockActiveHospital } from "./hospital-lifecycle.policy.js";
import { hospitalTeamFields, insertStaffAccount } from "./hospital-team.service.js";

const createMember = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email().max(254),
  role: z.enum(HOSPITAL_TEAM_ROLES),
  branchId: z.string().uuid(),
  password: z.string().min(12).max(128),
}).strict();

export async function hospitalTeamRoutes(app: FastifyInstance) {
  const preHandler = requirePermission("MANAGE_HOSPITAL_TEAM");
  app.get("/hospital-team", { preHandler }, async (request) => {
    const { tenantId } = request.sessionUser!;
    const items = await app.db.select({ ...hospitalTeamFields, branchName: branches.name }).from(users)
      .leftJoin(branches, and(eq(branches.id, users.branchId), eq(branches.tenantId, tenantId)))
      .where(eq(users.tenantId, tenantId)).orderBy(users.name, users.id);
    return { items };
  });

  app.post("/hospital-team", { preHandler, bodyLimit: 4096 }, async (request, reply) => {
    const actor = request.sessionUser!;
    const parsed = createMember.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const { name, email, role, branchId, password } = parsed.data;
    if (!canCreateHospitalTeamRole(actor.role, role)) return reply.status(403).send({ error: "forbidden" });
    if (email === password.toLowerCase()) return reply.status(400).send({ error: "invalid_password" });
    const passwordHash = await hashPassword(password);
    const result = await app.db.transaction(async (tx) => {
      if (!await lockActiveHospital(tx, actor.tenantId)) return { error: "hospital_unavailable" } as const;
      const [current] = await tx.select({ role: users.role }).from(users)
        .where(and(eq(users.id, actor.id), eq(users.tenantId, actor.tenantId))).for("share");
      if (!current || !canCreateHospitalTeamRole(current.role, role)) return { error: "forbidden" } as const;
      const [branch] = await tx.select({ name: branches.name }).from(branches)
        .where(and(eq(branches.id, branchId), eq(branches.tenantId, actor.tenantId))).for("share");
      if (!branch) return { error: "invalid_branch" } as const;
      const member = await insertStaffAccount(tx, { tenantId: actor.tenantId, branchId, name, email, passwordHash, role });
      if (!member) return { error: "email_in_use" } as const;
      await recordActivity(tx, { tenantId: actor.tenantId, actorId: actor.id, action: "hospital_team.created",
        entityType: "user", entityKey: member.id, metadata: { role, branchId } });
      return { member: { ...member, branchName: branch.name } };
    });
    if (result.error) {
      const status = { forbidden: 403, invalid_branch: 400, email_in_use: 409, hospital_unavailable: 409 };
      return reply.status(status[result.error]).send({ error: result.error });
    }
    return reply.status(201).send(result.member);
  });
}
