import { and, eq, inArray, or } from "drizzle-orm";
import { deriveOperationalStatus, type JourneyStage, type OperationalStatusKey } from "@pulseos/types";
import type { Db } from "../../db/client.js";
import { appointments, tasks, treatmentOpportunities } from "../../db/schema.js";

/**
 * The derived operational status of journeys (see deriveOperationalStatus in @pulseos/types for the precedence).
 * One read of the journeys' appointments, treatments and open tasks - never a query per journey - and always scoped
 * to the tenant. Nothing is stored: the same facts give the same answer on every screen.
 */
export async function loadOperationalStatuses(db: Db, tenantId: string, journeyList: { id: string; stage: JourneyStage }[]): Promise<Map<string, OperationalStatusKey | null>> {
  const out = new Map<string, OperationalStatusKey | null>();
  if (journeyList.length === 0) return out;
  const ids = journeyList.map((j) => j.id);
  // A handful of journeys are fetched by id; the whole list (the Leads workspace) is one tenant-wide read.
  const narrow = ids.length <= 200;

  const [apptRows, treatmentRows, taskRows] = await Promise.all([
    db
      .select({ journeyId: appointments.journeyId, status: appointments.status, scheduledAt: appointments.scheduledAt })
      .from(appointments)
      .where(and(eq(appointments.tenantId, tenantId), narrow ? inArray(appointments.journeyId, ids) : undefined)),
    db
      .select({ journeyId: treatmentOpportunities.journeyId, status: treatmentOpportunities.status })
      .from(treatmentOpportunities)
      .where(and(eq(treatmentOpportunities.tenantId, tenantId), narrow ? inArray(treatmentOpportunities.journeyId, ids) : undefined)),
    db
      .select({ journeyId: tasks.journeyId, type: tasks.type })
      .from(tasks)
      .where(and(eq(tasks.tenantId, tenantId), or(eq(tasks.status, "pending"), eq(tasks.status, "in_progress")), narrow ? inArray(tasks.journeyId, ids) : undefined)),
  ]);

  const group = <T extends { journeyId: string | null }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) if (r.journeyId) m.set(r.journeyId, [...(m.get(r.journeyId) ?? []), r]);
    return m;
  };
  const appts = group(apptRows);
  const treatments = group(treatmentRows);
  const openTasks = group(taskRows);

  for (const j of journeyList) {
    out.set(
      j.id,
      deriveOperationalStatus({
        stage: j.stage,
        appointments: (appts.get(j.id) ?? []).map((a) => ({ status: a.status, scheduledAt: a.scheduledAt })),
        treatments: (treatments.get(j.id) ?? []).map((t) => ({ status: t.status })),
        openTaskTypes: (openTasks.get(j.id) ?? []).map((t) => t.type),
      }),
    );
  }
  return out;
}
