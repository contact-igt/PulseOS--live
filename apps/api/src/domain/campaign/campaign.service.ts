import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import {
  appointments,
  campaignTouchpoints,
  connectors,
  consultationOutcomes,
  journeys,
  marketingCampaigns,
  patients,
  revenueEvents,
  specialtyTemplates,
  treatmentOpportunities,
} from "../../db/schema.js";
import { costPer, roas as roasOf } from "../marketing/formulas.js";
import { getSpendAtRiskByReason } from "../dashboard/dashboard.service.js";
import { inLocalRange, localToday, tenantTimezone } from "../../lib/hospital-time.js";
import { loadCampaignRunDays, spendInRange } from "../marketing/campaign-run-days.js";
import type { CampaignFilters, CampaignViewRow, MarketingEfficiencySummary, SpendAtRisk } from "@pulseos/types";

const NON_TERMINAL_TREATMENT = new Set(["ADVISED", "DECISION_PENDING", "ACCEPTED", "SCHEDULED", "COMPLETED"]);

// Rows carry the run window (startDate, endDate, status) so the Campaigns
// Table / Calendar / Timeline views are three presentations of one query.
// endDate stays null for an ongoing campaign — never defaulted or guessed.
export async function getCampaignPerformance(db: Db, tenantId: string, filters: CampaignFilters): Promise<CampaignViewRow[]> {
  const campaigns = await db
    .select()
    .from(marketingCampaigns)
    .where(and(eq(marketingCampaigns.tenantId, tenantId), filters.source ? eq(marketingCampaigns.source, filters.source) : undefined, filters.campaignId ? eq(marketingCampaigns.id, filters.campaignId) : undefined));

  // Dates are hospital-calendar days. A range bounds the leads (touchpoints that happened in it) and prorates spend over
  // the days each campaign ran inside it; with no dates spend is lifetime, as before.
  const timezone = await tenantTimezone(db, tenantId);
  const today = await localToday(db, timezone, new Date());
  const ranged = !!(filters.dateFrom || filters.dateTo);
  const range = { from: filters.dateFrom ?? "1970-01-01", to: filters.dateTo ?? today };
  const runDays = ranged ? await loadCampaignRunDays(db, tenantId, timezone) : new Map();
  const spendOf = (c: (typeof campaigns)[number]) => (ranged ? Math.round(spendInRange(c.spendAmount, runDays.get(c.id), range, today)) : c.spendAmount);

  const specialties = await db.select({ key: specialtyTemplates.key, displayName: specialtyTemplates.displayName }).from(specialtyTemplates).where(eq(specialtyTemplates.tenantId, tenantId));
  const specialtyLabelByKey = new Map(specialties.map((s) => [s.key, s.displayName]));

  // A synced campaign's numbers are only as real as the connector that
  // produced them — one lookup up front, same pattern as getSourcePerformance.
  const connectorModeById = new Map(
    (await db.select({ id: connectors.id, mode: connectors.mode }).from(connectors).where(eq(connectors.tenantId, tenantId))).map((c) => [c.id, c.mode]),
  );

  const rows: CampaignViewRow[] = [];

  for (const campaign of campaigns) {
    const connectorMode = campaign.connectorId ? (connectorModeById.get(campaign.connectorId) ?? null) : null;
    const spend = spendOf(campaign);
    const runWindow = {
      startDate: campaign.startDate.toISOString(),
      endDate: campaign.endDate ? campaign.endDate.toISOString() : null,
      campaignStatus: campaign.status,
    };
    const touchpointRows = await db
      .select({ journeyId: campaignTouchpoints.journeyId })
      .from(campaignTouchpoints)
      .where(and(
        eq(campaignTouchpoints.tenantId, tenantId),
        eq(campaignTouchpoints.campaignId, campaign.id),
        ranged ? inLocalRange(campaignTouchpoints.occurredAt, timezone, range.from, range.to) : undefined,
      ));
    let journeyIds = touchpointRows.map((r) => r.journeyId);

    if (journeyIds.length > 0 && (filters.specialtyKey || filters.branchId)) {
      const journeyRows = await db
        .select({ id: journeys.id, specialtyKey: journeys.specialtyKey, patientId: journeys.patientId })
        .from(journeys)
        .where(and(eq(journeys.tenantId, tenantId), inArray(journeys.id, journeyIds)));

      let allowedIds = new Set(journeyRows.map((j) => j.id));
      if (filters.specialtyKey) {
        allowedIds = new Set(journeyRows.filter((j) => j.specialtyKey === filters.specialtyKey).map((j) => j.id));
      }
      if (filters.branchId) {
        const patientIds = journeyRows.map((j) => j.patientId);
        const patientRows = patientIds.length ? await db.select({ id: patients.id }).from(patients).where(and(eq(patients.tenantId, tenantId), eq(patients.branchId, filters.branchId), inArray(patients.id, patientIds))) : [];
        const patientIdSet = new Set(patientRows.map((p) => p.id));
        const branchAllowed = new Set(journeyRows.filter((j) => patientIdSet.has(j.patientId)).map((j) => j.id));
        allowedIds = filters.specialtyKey ? new Set([...allowedIds].filter((id) => branchAllowed.has(id))) : branchAllowed;
      }
      journeyIds = journeyIds.filter((id) => allowedIds.has(id));
    } else if (filters.specialtyKey || filters.branchId) {
      journeyIds = [];
    }

    if (journeyIds.length === 0) {
      if (filters.specialtyKey || filters.branchId) continue; // no journeys matched these filters for this campaign
      rows.push({
        campaignId: campaign.id,
        campaignName: campaign.name,
        source: campaign.source,
        specialtyKey: null,
        specialtyLabel: null,
        spend,
        leads: 0,
        appointments: 0,
        consultations: 0,
        treatmentAdvised: 0,
        treatmentCompleted: 0,
        revenue: 0,
        cpl: null,
        costPerAppointment: null,
        costPerTreatment: null,
        roas: null,
        connectorMode,
        ...runWindow,
      });
      continue;
    }

    const [apptCount, consultCount, treatmentRows, revenueRow] = await Promise.all([
      db.select({ c: appointments.id }).from(appointments).where(and(eq(appointments.tenantId, tenantId), inArray(appointments.journeyId, journeyIds))).then((r) => r.length),
      db.select({ c: consultationOutcomes.id }).from(consultationOutcomes).where(and(eq(consultationOutcomes.tenantId, tenantId), inArray(consultationOutcomes.journeyId, journeyIds))).then((r) => r.length),
      db.select({ status: treatmentOpportunities.status }).from(treatmentOpportunities).where(and(eq(treatmentOpportunities.tenantId, tenantId), inArray(treatmentOpportunities.journeyId, journeyIds))),
      db.select({ amount: revenueEvents.amount }).from(revenueEvents).where(and(eq(revenueEvents.tenantId, tenantId), inArray(revenueEvents.journeyId, journeyIds))),
    ]);

    const treatmentAdvised = treatmentRows.filter((t) => NON_TERMINAL_TREATMENT.has(t.status)).length;
    const treatmentCompleted = treatmentRows.filter((t) => t.status === "COMPLETED").length;
    const revenue = revenueRow.reduce((sum, r) => sum + r.amount, 0);

    rows.push({
      campaignId: campaign.id,
      campaignName: campaign.name,
      source: campaign.source,
      specialtyKey: filters.specialtyKey ?? null,
      specialtyLabel: filters.specialtyKey ? (specialtyLabelByKey.get(filters.specialtyKey) ?? filters.specialtyKey) : null,
      spend,
      leads: journeyIds.length,
      appointments: apptCount,
      consultations: consultCount,
      treatmentAdvised,
      treatmentCompleted,
      revenue,
      cpl: costPer(spend, journeyIds.length),
      costPerAppointment: costPer(spend, apptCount),
      costPerTreatment: costPer(spend, treatmentCompleted),
      roas: roasOf(revenue, spend),
      connectorMode,
      ...runWindow,
    });
  }

  return rows.sort((a, b) => b.spend - a.spend);
}

export async function getMarketingEfficiency(db: Db, tenantId: string, filters: CampaignFilters): Promise<MarketingEfficiencySummary> {
  const rows = await getCampaignPerformance(db, tenantId, filters);
  const spend = rows.reduce((sum, r) => sum + r.spend, 0);
  const leads = rows.reduce((sum, r) => sum + r.leads, 0);
  const appointmentsCount = rows.reduce((sum, r) => sum + r.appointments, 0);
  const consultations = rows.reduce((sum, r) => sum + r.consultations, 0);
  const treatments = rows.reduce((sum, r) => sum + r.treatmentCompleted, 0);
  const revenue = rows.reduce((sum, r) => sum + r.revenue, 0);

  return {
    spend,
    leads,
    appointments: appointmentsCount,
    consultations,
    treatments,
    revenue,
    roas: roasOf(revenue, spend),
    cpl: costPer(spend, leads),
    costPerAppointment: costPer(spend, appointmentsCount),
    costPerTreatment: costPer(spend, treatments),
  };
}

export async function getCampaignSpendAtRisk(db: Db, tenantId: string): Promise<SpendAtRisk> {
  return getSpendAtRiskByReason(db, tenantId);
}
