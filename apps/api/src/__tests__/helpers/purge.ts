import { sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";

/**
 * Remove fictional patients a test created, with everything hanging off them, in foreign-key order.
 * Tests that create leads / journeys use this so they leave the shared test database as they found it.
 */
export async function purgePatientData(db: Db, patientIds: string[]): Promise<void> {
  if (patientIds.length === 0) return;
  const ids = sql.join(patientIds.map((id) => sql`${id}::uuid`), sql`, `);
  const statements = [
    sql`update journeys set last_outcome_id = null where patient_id in (${ids})`,
    sql`delete from revenue_events where patient_id in (${ids})`,
    sql`delete from conversion_feedback_events where patient_id in (${ids})`,
    sql`delete from treatment_opportunities where patient_id in (${ids})`,
    sql`delete from consultation_outcomes where patient_id in (${ids})`,
    sql`delete from conversation_summaries where patient_id in (${ids})`,
    sql`delete from messages where conversation_id in (select id from conversations where patient_id in (${ids}))`,
    sql`delete from conversation_automation_preferences where conversation_id in (select id from conversations where patient_id in (${ids}))`,
    sql`delete from conversations where patient_id in (${ids})`,
    sql`delete from call_intelligence where call_id in (select id from calls where patient_id in (${ids}))`,
    sql`update calls set callback_task_id = null where patient_id in (${ids})`,
    sql`delete from calls where patient_id in (${ids})`,
    sql`delete from campaign_touchpoints where patient_id in (${ids})`,
    sql`delete from custom_field_values where journey_id in (select id from journeys where patient_id in (${ids}))`,
    sql`delete from timeline_events where patient_id in (${ids})`,
    sql`delete from tasks where patient_id in (${ids})`,
    sql`delete from notifications where patient_id in (${ids})`,
    sql`delete from appointments where patient_id in (${ids})`,
    sql`delete from journeys where patient_id in (${ids})`,
    sql`delete from patients where id in (${ids})`,
  ];
  for (const s of statements) await db.execute(s);
}
