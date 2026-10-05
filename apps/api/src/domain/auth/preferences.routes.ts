import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { INTERFACE_SIZES, TEXT_SIZES } from "@pulseos/types";
import { users } from "../../db/schema.js";

// "My display": each signed-in person chooses how roomy the interface is and how large the text is, FOR THEMSELVES. It is stored on
// the user row, so it follows the person across devices and sign-ins and never changes anyone else's screen. The user and the
// hospital always come from the session - there is no way to name another person. Two bounded names, never a raw size.
const body = z
  .object({ interfaceSize: z.enum(INTERFACE_SIZES).optional(), textSize: z.enum(TEXT_SIZES).optional() })
  .strict()
  .refine((v) => v.interfaceSize !== undefined || v.textSize !== undefined, "nothing to change");

export async function preferencesRoutes(app: FastifyInstance) {
  app.put("/me/preferences", async (request, reply) => {
    const parsed = body.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    const me = request.sessionUser!;
    const [row] = await app.db
      .update(users)
      .set({ ...(parsed.data.interfaceSize ? { interfaceSize: parsed.data.interfaceSize } : {}), ...(parsed.data.textSize ? { textSize: parsed.data.textSize } : {}) })
      .where(and(eq(users.id, me.id), eq(users.tenantId, me.tenantId)))
      .returning({ interfaceSize: users.interfaceSize, textSize: users.textSize });
    return { interfaceSize: row?.interfaceSize ?? "comfortable", textSize: row?.textSize ?? "default" };
  });
}
