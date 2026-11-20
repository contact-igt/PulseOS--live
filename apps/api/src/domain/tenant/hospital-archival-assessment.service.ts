import { and, count, eq, gte, inArray, like, or, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import {
  adsSyncRuns, appointments, callIntelligence, calls, connectorEvents, connectors,
  hospitalInvitationDeliveries, hospitalMessagingCommands, hospitalOnboardings, notifications,
  outboundWebhookDeliveries, outboundWebhooks, revenueEvents, suspendedMetaLeads, tasks, tenants,
} from "../../db/schema.js";
import { targetTenant } from "./hospital-lifecycle.service.js";
import { readMessagingCoordination } from "./hospital-messaging.service.js";
import type { HospitalArchivalAssessment } from "@pulseos/types";
import { z } from "zod";

const observedState = z.object({
  state: z.enum(["ACTIVE", "PAUSING", "PAUSED"]),
  unresolvedPermits: z.number().int().nonnegative().safe(),
});

export async function readHospitalArchivalAssessment(db: Db, target: Parameters<typeof targetTenant>[1]): Promise<HospitalArchivalAssessment | null> {
  return db.transaction(async (tx) => {
    const tenantId = await targetTenant(tx, target);
    if (!tenantId) return null;
    const now = new Date();
    const [[hospital], [onboarding], [appointmentWork], [taskWork], [notificationWork], [webhookWork],
      [commandWork], [events], [heldLeads], [adsWork], [callWork], [financialEvidence], [binding], messaging] = await Promise.all([
      tx.select({ state: tenants.lifecycleStatus, version: tenants.lifecycleVersion }).from(tenants).where(eq(tenants.id, tenantId)),
      tx.select({ template: hospitalOnboardings.templateStatus, issued: sql<boolean>`${hospitalOnboardings.invitationHash} is not null`,
        expiresAt: hospitalOnboardings.invitationExpiresAt, redeemedAt: hospitalOnboardings.invitationRedeemedAt,
        delivery: hospitalInvitationDeliveries.status }).from(hospitalOnboardings)
        .leftJoin(hospitalInvitationDeliveries, eq(hospitalInvitationDeliveries.onboardingId, hospitalOnboardings.id))
        .where(eq(hospitalOnboardings.tenantId, tenantId)),
      tx.select({ future: count(sql`case when ${gte(appointments.scheduledAt, now)} then 1 end`), unresolved: count() }).from(appointments)
        .where(and(eq(appointments.tenantId, tenantId), inArray(appointments.status,
          ["requested", "scheduled", "confirmed", "checked_in", "waiting", "with_doctor"]))),
      tx.select({ count: count() }).from(tasks).where(and(eq(tasks.tenantId, tenantId), eq(tasks.status, "pending"))),
      tx.select({ pending: count(sql`case when ${notifications.status} in ('PENDING', 'PROCESSING') then 1 end`),
        unknown: count(sql`case when ${notifications.status} = 'FAILED' and ${notifications.provider} = 'whatsnexus'
          and ${like(notifications.reason, "OUTCOME_UNKNOWN%")} then 1 end`) }).from(notifications).where(eq(notifications.tenantId, tenantId)),
      tx.select({ count: count() }).from(outboundWebhookDeliveries).innerJoin(outboundWebhooks,
        and(eq(outboundWebhooks.id, outboundWebhookDeliveries.webhookId), eq(outboundWebhooks.tenantId, tenantId)))
        .where(and(eq(outboundWebhookDeliveries.tenantId, tenantId), eq(outboundWebhookDeliveries.status, "PENDING"))),
      tx.select({ pending: count(sql`case when ${hospitalMessagingCommands.status} = 'pending' then 1 end`),
        failed: count(sql`case when ${hospitalMessagingCommands.status} = 'failed' then 1 end`) }).from(hospitalMessagingCommands)
        .where(eq(hospitalMessagingCommands.tenantId, tenantId)),
      tx.select({ count: count() }).from(connectorEvents).innerJoin(connectors,
        and(eq(connectors.id, connectorEvents.connectorId), eq(connectors.tenantId, tenantId)))
        .where(and(eq(connectorEvents.tenantId, tenantId), inArray(connectorEvents.status, ["received", "failed"]))),
      tx.select({ count: count() }).from(suspendedMetaLeads).innerJoin(connectors,
        and(eq(connectors.id, suspendedMetaLeads.connectorId), eq(connectors.tenantId, tenantId)))
        .where(eq(suspendedMetaLeads.tenantId, tenantId)),
      tx.select({ count: count() }).from(adsSyncRuns).where(and(eq(adsSyncRuns.tenantId, tenantId), eq(adsSyncRuns.status, "RUNNING"))),
      tx.select({ count: count() }).from(callIntelligence).innerJoin(calls,
        and(eq(calls.id, callIntelligence.callId), eq(calls.tenantId, tenantId)))
        .where(and(eq(callIntelligence.tenantId, tenantId), or(inArray(callIntelligence.transcriptStatus, ["PENDING", "PROCESSING"]),
          inArray(callIntelligence.summaryStatus, ["PENDING", "PROCESSING"])))),
      tx.select({ present: sql<boolean>`true` }).from(revenueEvents).where(eq(revenueEvents.tenantId, tenantId)).limit(1),
      tx.select({ mode: connectors.mode }).from(connectors).where(and(eq(connectors.tenantId, tenantId), eq(connectors.provider, "whatsnexus"))),
      readMessagingCoordination(tx, tenantId),
    ]);
    if (!hospital) return null;
    const invitation = !onboarding ? "legacy" : onboarding.redeemedAt ? "redeemed"
      : !onboarding.issued ? "not_issued" : onboarding.expiresAt && onboarding.expiresAt > now ? "pending" : "expired";
    const latest = messaging.latest;
    const parsed = observedState.safeParse(latest?.observation);
    const observation = latest?.verifiedAt && parsed.success ? parsed.data : null;
    const aligned = Boolean(observation && binding?.mode === "LIVE" && messaging.enabled && messaging.bindingCurrent
      && latest?.lifecycleVersion === hospital.version);
    const evidence = {
      appointments: appointmentWork!.unresolved, futureAppointments: appointmentWork!.future, pendingTasks: taskWork!.count,
      pendingNotifications: notificationWork!.pending, unknownDispatches: notificationWork!.unknown,
      pendingWebhooks: webhookWork!.count, pendingCommands: commandWork!.pending, recordedFailedCommands: commandWork!.failed,
      openConnectorEvents: events!.count, heldMetaLeads: heldLeads!.count,
      runningAdsSyncs: adsWork!.count, pendingOrRunningCallWork: callWork!.count,
    };
    const findings: HospitalArchivalAssessment["findings"] = [
      { classification: "POLICY_NOT_APPROVED", basis: "policy", reason: "Archival and retention policy requires approval." },
      { classification: "BLOCKED_BY_CLINICAL_REVIEW", basis: "policy", reason: "Clinical continuity and historical access require sign-off." },
      { classification: "BLOCKED_BY_FINANCE_REVIEW", basis: "policy", reason: "Finance must reconcile outstanding obligations separately." },
      { classification: "EVIDENCE_UNAVAILABLE", basis: "record", reason: "Legal holds, outstanding financial obligations and complete worker or provider backlog are not established by local records." },
    ];
    if (hospital.state !== "SUSPENDED") findings.push({ classification: "BLOCKED_BY_STATE", basis: "policy", reason: "The proposed policy requires a suspended hospital." });
    if (invitation === "pending" || onboarding?.delivery === "pending" || onboarding?.template === "pending"
      || evidence.appointments || evidence.pendingTasks || evidence.pendingNotifications || evidence.pendingWebhooks
      || evidence.runningAdsSyncs || evidence.pendingOrRunningCallWork) {
      findings.push({ classification: "BLOCKED_BY_OPEN_WORK", basis: "record", reason: "Local records show open onboarding, appointment or background work." });
    }
    if (evidence.pendingCommands || (latest?.status === "failed" && latest.lifecycleVersion === hospital.version)
      || evidence.unknownDispatches || evidence.openConnectorEvents || evidence.heldMetaLeads
      || (aligned && (observation?.state !== "PAUSED" || Boolean(observation.unresolvedPermits)))) {
      findings.push({ classification: "BLOCKED_BY_INTEGRATION", basis: "record", reason: "Local records or the last matching observation show integration work or an unconfirmed pause." });
    }
    if (binding || latest) findings.push({ classification: "EVIDENCE_UNAVAILABLE", basis: "record", reason: "Live WhatsNexus state and permit counts were not checked. Stored observations describe the provider only at the recorded time." });
    return {
      assessedAt: now.toISOString(), lifecycle: hospital, onboarding: { invitation, delivery: onboarding?.delivery ?? null, template: onboarding?.template ?? null },
      evidence, recordedRevenue: Boolean(financialEvidence?.present),
      whatsNexus: { binding: binding?.mode ?? null, observation: observation && latest?.verifiedAt ? {
        state: observation.state, observedAt: latest.verifiedAt.toISOString(), alignment: aligned ? "matching" : "historical",
        unresolvedPermits: aligned ? observation.unresolvedPermits : null,
      } : null },
      findings,
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
