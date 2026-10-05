import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, queryClient } from "../db/client.js";

// A follow-up/recall/post-care task for a patient who has exactly one
// Journey belongs to that Journey — otherwise it never appears on the
// Journey page and My Work shows it as "No journey". Seeded demo data must
// model that correctly. (Run against a freshly seeded database.)
const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)("seeded tasks are linked to their Journey", () => {
  afterAll(async () => {
    await queryClient.end();
  });

  it("no seeded task of a single-journey patient is left without a journeyId", async () => {
    const rows = await db.execute(sql`
      SELECT t.name AS tenant, p.name AS patient, k.notes
      FROM tasks k
      JOIN patients p ON p.id = k.patient_id
      JOIN tenants t ON t.id = k.tenant_id
      WHERE k.journey_id IS NULL
        AND t.name LIKE 'PulseOS % Demo'
        AND (SELECT count(*) FROM journeys j WHERE j.patient_id = k.patient_id) = 1
    `);
    expect(rows).toEqual([]);
  });
});
