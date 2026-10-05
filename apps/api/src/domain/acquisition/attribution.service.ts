import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { campaignTouchpoints, marketingCampaigns, type SourceChannelDb } from "../../db/schema.js";
import { buildTouchpointValues, type TouchpointDetails } from "./touchpoint.js";

// Find-or-create by (tenantId, externalCampaignId) — the DB unique index
// (marketing_campaigns_tenant_external_unique) is the actual duplicate
// guard; the catch-and-refetch here only handles the race where two
// webhooks for a brand-new campaign land concurrently, mirroring the same
// pattern used for connector_events idempotency. When there is no
// externalCampaignId (a manually-entered lead attributed to an existing,
// manually-created MarketingCampaign row), the caller passes a campaignId
// directly instead of calling this.
export async function resolveCampaign(
  db: Db,
  tenantId: string,
  input: { source: SourceChannelDb; externalCampaignId: string | null; name: string; connectorId?: string | null },
): Promise<string | null> {
  if (!input.externalCampaignId) return null;

  const [existing] = await db
    .select({ id: marketingCampaigns.id })
    .from(marketingCampaigns)
    .where(and(eq(marketingCampaigns.tenantId, tenantId), eq(marketingCampaigns.externalCampaignId, input.externalCampaignId)))
    .limit(1);
  if (existing) return existing.id;

  try {
    const [created] = await db
      .insert(marketingCampaigns)
      .values({
        tenantId,
        // Stamped even for this reactive, per-touchpoint find-or-create path
        // so a campaign auto-created from a fixture connector's webhook is
        // just as traceable to its connector's mode as one from an explicit
        // sync — Campaigns/Sources and Command Centre never show it with no
        // mode context at all (which would read as ambiguously "maybe real").
        connectorId: input.connectorId ?? null,
        source: input.source,
        name: input.name,
        externalCampaignId: input.externalCampaignId,
        startDate: new Date(),
        status: "active",
      })
      .returning({ id: marketingCampaigns.id });
    return created.id;
  } catch {
    const [raceWinner] = await db
      .select({ id: marketingCampaigns.id })
      .from(marketingCampaigns)
      .where(and(eq(marketingCampaigns.tenantId, tenantId), eq(marketingCampaigns.externalCampaignId, input.externalCampaignId)))
      .limit(1);
    if (!raceWinner) throw new Error("failed to resolve or create marketing campaign");
    return raceWinner.id;
  }
}

// The only place a touchpoint row is ever inserted. The journey's very
// first touchpoint is permanently "first_touch" and is never re-written by
// later calls; every later call inserts its own new "last_touch" row, so
// the full history is just every row for the journey ordered by
// occurredAt, and "the" current last touch is the most recent "last_touch"
// row. campaignId, when already resolved by the caller (e.g. a manual
// Add Lead picking an existing campaign from a dropdown), is passed
// directly and resolveCampaign is skipped.
export async function recordTouchpoint(
  db: Db,
  input: {
    tenantId: string;
    patientId: string;
    journeyId: string;
    details: TouchpointDetails;
    campaignId?: string | null;
    campaignName?: string;
    connectorId?: string | null;
  },
): Promise<{ touchpointId: string; touchType: "first_touch" | "last_touch"; campaignId: string | null }> {
  const campaignId =
    input.campaignId !== undefined
      ? input.campaignId
      : await resolveCampaign(db, input.tenantId, {
          source: input.details.source,
          externalCampaignId: input.details.externalCampaignId ?? null,
          name: input.campaignName ?? input.details.source,
          connectorId: input.connectorId,
        });

  const [existingFirstTouch] = await db
    .select({ id: campaignTouchpoints.id })
    .from(campaignTouchpoints)
    .where(and(eq(campaignTouchpoints.journeyId, input.journeyId), eq(campaignTouchpoints.touchType, "first_touch")))
    .limit(1);

  const touchType: "first_touch" | "last_touch" = existingFirstTouch ? "last_touch" : "first_touch";

  const [row] = await db
    .insert(campaignTouchpoints)
    .values(
      buildTouchpointValues({
        details: input.details,
        tenantId: input.tenantId,
        patientId: input.patientId,
        journeyId: input.journeyId,
        campaignId,
        touchType,
      }),
    )
    .returning({ id: campaignTouchpoints.id });

  return { touchpointId: row.id, touchType, campaignId };
}

// Full ordered history for a journey — first touch first, every subsequent
// touch (each stored as "last_touch" at the time it was recorded) in order.
export async function listTouchpointHistory(db: Db, journeyId: string) {
  return db
    .select()
    .from(campaignTouchpoints)
    .where(eq(campaignTouchpoints.journeyId, journeyId))
    .orderBy(campaignTouchpoints.occurredAt);
}

// The current last touch — the most recently recorded "last_touch" row, or
// the first touch itself when only one touchpoint has ever been recorded.
export async function getCurrentLastTouch(db: Db, journeyId: string) {
  const [lastTouch] = await db
    .select()
    .from(campaignTouchpoints)
    .where(and(eq(campaignTouchpoints.journeyId, journeyId), eq(campaignTouchpoints.touchType, "last_touch")))
    .orderBy(desc(campaignTouchpoints.occurredAt))
    .limit(1);
  if (lastTouch) return lastTouch;

  const [firstTouch] = await db
    .select()
    .from(campaignTouchpoints)
    .where(and(eq(campaignTouchpoints.journeyId, journeyId), eq(campaignTouchpoints.touchType, "first_touch")))
    .limit(1);
  return firstTouch ?? null;
}

export interface AttributionSummary {
  firstTouch: typeof campaignTouchpoints.$inferSelect | null;
  currentLastTouch: typeof campaignTouchpoints.$inferSelect | null;
  history: (typeof campaignTouchpoints.$inferSelect)[];
}

// The single read surface Patient 360 / Campaigns drill-down and Command
// Centre build on: a journey's immutable first touch, its current last
// touch, and the full ordered history between them — including
// cross-provider sequences (a Meta touch followed later by a Google touch
// on the same still-open journey, once those adapters are ported), which
// fall out naturally from how recordTouchpoint already writes these rows.
export async function getAttributionSummary(db: Db, journeyId: string): Promise<AttributionSummary> {
  const [history, currentLastTouch] = await Promise.all([
    listTouchpointHistory(db, journeyId),
    getCurrentLastTouch(db, journeyId),
  ]);
  const firstTouch = history.find((t) => t.touchType === "first_touch") ?? null;
  return { firstTouch, currentLastTouch, history };
}
