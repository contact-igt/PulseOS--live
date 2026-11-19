import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { connectors, connectorSecrets, runoAllocations } from "../../db/schema.js";
import { decryptSecret } from "../security/encryption.js";

const optionalText = z.string().nullish();
const allocation = z.object({
  _id: z.string().min(1),
  processName: z.string().min(1),
  createdAt: z.number().int().nonnegative().max(253402300799),
  customer: z.object({ name: optionalText, phoneNumber: optionalText }).nullish(),
  assigned: z.object({ to: optionalText }).nullish(),
  status: optionalText,
  source: optionalText,
  branch: optionalText,
  userFields: z.array(z.object({ name: z.string(), value: z.unknown() })).nullish(),
});

const pageSchema = z.object({
  statusCode: z.literal(0),
  data: z.object({
    metadata: z.array(z.object({ total: z.number().int().nonnegative(), page: z.number().int() })),
    data: z.array(allocation).max(100),
  }),
});

export async function importRunoAllocations(db: Db, tenantId: string, input: { date: string; processName: string }) {
  const [credential] = await db.select({ payload: connectorSecrets.encryptedPayload })
    .from(connectors)
    .innerJoin(connectorSecrets, eq(connectors.id, connectorSecrets.connectorId))
    .where(and(eq(connectors.tenantId, tenantId), eq(connectors.provider, "runo")))
    .limit(1);
  let apiKey: unknown;
  try {
    apiKey = credential && decryptSecret(credential.payload).allocationsApiKey;
  } catch {
    return { error: "runo_key_unavailable" } as const;
  }
  if (typeof apiKey !== "string" || !apiKey) return { error: "runo_key_unavailable" } as const;

  const rows = new Map<string, typeof runoAllocations.$inferInsert>();
  const url = new URL("https://api.runo.in/v1/crm/allocations");
  url.searchParams.set("date", input.date);
  url.searchParams.set("processName", input.processName);
  const signal = AbortSignal.timeout(25_000);
  let total = 0;
  let pages = 1;
  try {
    for (let page = 1; page <= pages; page += 1) {
      url.searchParams.set("pageNo", String(page));
      const response = await fetch(url, { headers: { "Auth-Key": apiKey }, redirect: "error", signal });
      if (response.status === 401 || response.status === 403) return { error: "runo_key_rejected" } as const;
      if (!response.ok) return { error: "runo_unavailable" } as const;
      const result = pageSchema.parse(await response.json()).data;
      const meta = result.metadata[0];
      if (!meta && page === 1 && result.data.length === 0) break;
      if (!meta || meta.page !== page) return { error: "runo_unexpected_response" } as const;
      if (page === 1) {
        total = meta.total;
        pages = Math.ceil(total / 100);
      }
      for (const row of result.data) {
        if (row.processName.toLowerCase() !== input.processName.toLowerCase()) return { error: "runo_process_mismatch" } as const;
        const fields = new Map(row.userFields?.map(({ name, value }) => [name.trim().toLowerCase(), value]));
        const field = (name: string) => {
          const value = fields.get(name);
          return typeof value === "string" ? value : null;
        };
        rows.set(row._id, {
          tenantId, externalId: row._id, processName: row.processName,
          createdAt: new Date(row.createdAt * 1000),
          customerName: row.customer?.name ?? null, phone: row.customer?.phoneNumber ?? null,
          assignee: row.assigned?.to ?? null, status: row.status ?? field("status"),
          source: row.source ?? field("source"), branch: row.branch ?? field("branch"),
        });
      }
    }
  } catch (error) {
    return { error: error instanceof z.ZodError || error instanceof SyntaxError ? "runo_unexpected_response" : "runo_unavailable" } as const;
  }
  if (rows.size !== total) return { error: "runo_unexpected_response" } as const;

  const records = [...rows.values()].sort((a, b) => a.externalId.localeCompare(b.externalId));
  await db.transaction(async (tx) => {
    for (let offset = 0; offset < records.length; offset += 100) {
      await tx.insert(runoAllocations).values(records.slice(offset, offset + 100)).onConflictDoUpdate({
        target: [runoAllocations.tenantId, runoAllocations.externalId],
        set: {
          processName: sql`excluded.process_name`, customerName: sql`excluded.customer_name`,
          phone: sql`excluded.phone`, status: sql`excluded.status`, assignee: sql`excluded.assignee`,
          source: sql`excluded.source`, branch: sql`excluded.branch`, createdAt: sql`excluded.created_at`,
        },
      });
    }
  });
  return { imported: rows.size };
}

export async function listRunoAllocations(db: Db, tenantId: string, page: number) {
  const pageSize = 50;
  const rows = await db.select().from(runoAllocations)
    .where(eq(runoAllocations.tenantId, tenantId))
    .orderBy(desc(runoAllocations.createdAt), desc(runoAllocations.externalId))
    .limit(pageSize + 1).offset((page - 1) * pageSize);
  return { rows: rows.slice(0, pageSize), hasMore: rows.length > pageSize };
}
