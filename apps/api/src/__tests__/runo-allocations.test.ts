import { afterEach, expect, it, vi } from "vitest";
import type { Db } from "../db/client.js";
import { importRunoAllocations } from "../domain/integration/runo-allocations.service.js";

vi.mock("../domain/security/encryption.js", () => ({
  decryptSecret: () => ({ allocationsApiKey: "fixture" }),
}));

afterEach(() => vi.unstubAllGlobals());

it("saves received allocations and reports the shortfall when Runo repeats a page", async () => {
  const upsert = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate: upsert });
  const db = {
    select: () => ({ from: () => ({ innerJoin: () => ({ where: () => ({
      limit: async () => [{ payload: "fixture" }],
    }) }) }) }),
    transaction: async (callback: (tx: unknown) => Promise<void>) => callback({ insert: () => ({ values }) }),
  } as unknown as Db;
  const row = { _id: "allocation-1", processName: "Default process", createdAt: 1787135400 };
  const fetchMock = vi.fn(async () => Response.json({
    statusCode: 0, data: { metadata: [{ page: 1, total: 2 }], data: [row] },
  }));
  vi.stubGlobal("fetch", fetchMock);

  const result = await importRunoAllocations(db, "test-hospital", { date: "2026-08-19", processName: "Default process" });

  expect(result).toEqual({ imported: 1, expectedCount: 2 });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(values).toHaveBeenCalledWith([expect.objectContaining({ tenantId: "test-hospital", externalId: row._id })]);
  expect(upsert).toHaveBeenCalledOnce();
});
