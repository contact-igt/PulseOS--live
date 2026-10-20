import type { FastifyReply } from "fastify";
import type { ZodError, ZodTypeAny, z } from "zod";

/** 400 with field-level messages a person can act on (never values, never internals). */
export function invalid(reply: FastifyReply, error: ZodError) {
  return reply.status(400).send({ error: "invalid_request", issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
}

/** Parse or answer 400. Returns null when it has already answered. */
export function parse<S extends ZodTypeAny>(schema: S, value: unknown, reply: FastifyReply): z.infer<S> | null {
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) {
    void invalid(reply, parsed.error);
    return null;
  }
  return parsed.data;
}

/** A service refusal as HTTP: its own status (404 / 409 / 400), with the machine-readable reason and nothing else. */
export function refuse(reply: FastifyReply, r: { reason: string; status?: number; detail?: unknown }) {
  return reply.status(r.status ?? 400).send({ error: r.reason, ...(r.detail !== undefined ? { detail: r.detail } : {}) });
}

export const notFound = (reply: FastifyReply) => reply.status(404).send({ error: "not_found" });
