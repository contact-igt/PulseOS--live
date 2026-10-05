import { eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { marketingCampaigns } from "../../db/schema.js";
import { proratedSpend } from "../analytics/analytics.service.js";
import { tzLiteral } from "../../lib/hospital-time.js";

export interface CampaignRunDays {
  /** First / last hospital-local day the campaign runs. `endDay` is null while it is still running. */
  startDay: string;
  endDay: string | null;
}

/** Every campaign's run window as hospital-local days — the unit spend is prorated in. */
export async function loadCampaignRunDays(db: Db, tenantId: string, timezone: string): Promise<Map<string, CampaignRunDays>> {
  const tz = tzLiteral(timezone);
  const rows = await db
    .select({
      id: marketingCampaigns.id,
      startDay: sql<string>`to_char(${marketingCampaigns.startDate} at time zone ${tz}, 'YYYY-MM-DD')`,
      endDay: sql<string | null>`to_char(${marketingCampaigns.endDate} at time zone ${tz}, 'YYYY-MM-DD')`,
    })
    .from(marketingCampaigns)
    .where(eq(marketingCampaigns.tenantId, tenantId));
  return new Map(rows.map((r) => [r.id, { startDay: r.startDay, endDay: r.endDay }]));
}

/**
 * A campaign's spend inside [from, to] (hospital-local days): its spend spread evenly over the days it ran, counting
 * only the days that fall in the range. A still-running campaign extends to `today`.
 */
export function spendInRange(spend: number, run: CampaignRunDays | undefined, range: { from: string; to: string }, today: string): number {
  if (!run) return spend;
  return proratedSpend(spend, run.startDay, run.endDay ?? today, range.from, range.to);
}
