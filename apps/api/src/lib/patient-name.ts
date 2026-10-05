import { sql } from "drizzle-orm";
import { UNKNOWN_PATIENT_NAME } from "@pulseos/types";
import { patients } from "../db/schema.js";

export { UNKNOWN_PATIENT_NAME };

/** Select expression for a patient's display name: the stored name, or the unknown label when it is NULL/blank. */
export const patientNameSql = sql<string>`coalesce(nullif(btrim(${patients.name}), ''), ${UNKNOWN_PATIENT_NAME})`;
