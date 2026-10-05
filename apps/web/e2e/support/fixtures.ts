import { execFileSync } from "node:child_process";

// E2E specs run against the live dev DB (the one the dev API uses). Fixtures are
// fictional patients whose names carry a spec-specific marker; `purgePatients`
// removes them and every row hanging off them, pass or fail, so the demo
// tenants never accumulate test journeys, tasks or appointments.

const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgres://localhost:5432/pulseos_dev";

export function sql(statement: string): string {
  return execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-q", "-At", "-F", "|", "-c", statement], { encoding: "utf8" }).trim();
}

/** Delete test patients whose name starts with `namePrefix` (demo tenants only) and everything that references them. */
export function purgePatients(namePrefix: string) {
  if (namePrefix.trim().length < 2) throw new Error("purgePatients needs a specific marker prefix");
  const escaped = namePrefix.replace(/'/g, "''").replace(/[\\%_]/g, "\\$&");
  purgePatientsWhere(`p.name LIKE '${escaped}%'`);
}

/** Delete test patients by exact phone digits — for patients created WITHOUT a name, which a name prefix cannot find. */
export function purgePatientsByPhone(phones: string[]) {
  const safe = phones.filter((p) => /^\+?[0-9 ]{8,16}$/.test(p));
  if (safe.length === 0) return;
  purgePatientsWhere(`p.phone IN (${safe.map((p) => `'${p}'`).join(", ")})`);
}

function purgePatientsWhere(predicate: string) {
  // Demo hospitals only: the three PulseOS demos, the Namokar V1 demo and (marker-named QA records only) the Namokar V2 pilot. Never anything else.
  const ps = `SELECT p.id FROM patients p JOIN tenants t ON t.id = p.tenant_id WHERE (t.name LIKE 'PulseOS % Demo' OR t.name = 'Namokar Eye & Oculoplasty Centre' OR t.name = 'Namokar Eye & Oculoplasty Centre (Pilot)') AND ${predicate}`;
  const cs = `SELECT id FROM conversations WHERE patient_id IN (${ps})`;
  sql(`
    BEGIN;
    DELETE FROM notifications WHERE patient_id IN (${ps});
    DELETE FROM revenue_events WHERE patient_id IN (${ps});
    DELETE FROM conversion_feedback_events WHERE patient_id IN (${ps});
    DELETE FROM treatment_opportunities WHERE patient_id IN (${ps});
    DELETE FROM consultation_outcomes WHERE patient_id IN (${ps});
    DELETE FROM messages WHERE conversation_id IN (${cs});
    DELETE FROM conversation_automation_preferences WHERE conversation_id IN (${cs});
    DELETE FROM conversations WHERE patient_id IN (${ps});
    DELETE FROM call_intelligence WHERE call_id IN (SELECT id FROM calls WHERE patient_id IN (${ps}));
    UPDATE calls SET callback_task_id = NULL WHERE patient_id IN (${ps});
    DELETE FROM calls WHERE patient_id IN (${ps});
    DELETE FROM campaign_touchpoints WHERE patient_id IN (${ps});
    DELETE FROM custom_field_values WHERE journey_id IN (SELECT id FROM journeys WHERE patient_id IN (${ps}));
    DELETE FROM timeline_events WHERE patient_id IN (${ps});
    DELETE FROM tasks WHERE patient_id IN (${ps});
    DELETE FROM appointments WHERE patient_id IN (${ps});
    DELETE FROM journeys WHERE patient_id IN (${ps});
    DELETE FROM patients WHERE id IN (${ps});
    COMMIT;`);
}

/** Delete CRM fields whose key starts with `keyPrefix` (and any values recorded against them). Run after purgePatients. */
export function purgeCrmFields(keyPrefix: string) {
  if (!/^[a-z0-9_]{4,}$/.test(keyPrefix)) throw new Error("purgeCrmFields needs a specific key prefix");
  sql(`
    BEGIN;
    DELETE FROM custom_field_values WHERE field_definition_id IN (SELECT id FROM custom_field_definitions WHERE key LIKE '${keyPrefix}%');
    DELETE FROM custom_field_definitions WHERE key LIKE '${keyPrefix}%';
    COMMIT;`);
}

/**
 * Remove hospitals created by sign-up specs (names start with "E2E Signup ") and everything they own. Foreign keys are
 * switched off for the transaction (the local database user owns the database), so the order does not matter; orphaned
 * sessions and connector secrets are swept up afterwards.
 */
export function purgeSignupTenants() {
  sql(`
    BEGIN;
    SET LOCAL session_replication_role = replica;
    DO $$
    DECLARE r record; ids uuid[];
    BEGIN
      SELECT array_agg(id) INTO ids FROM tenants WHERE name LIKE 'E2E Signup %';
      IF ids IS NULL THEN RETURN; END IF;
      FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'tenant_id' AND table_name <> 'tenants' LOOP
        EXECUTE format('DELETE FROM %I WHERE tenant_id = ANY($1)', r.table_name) USING ids;
      END LOOP;
      DELETE FROM tenants WHERE id = ANY(ids);
      DELETE FROM sessions WHERE user_id NOT IN (SELECT id FROM users);
      DELETE FROM connector_secrets WHERE connector_id NOT IN (SELECT id FROM connectors);
    END $$;
    COMMIT;`);
}
