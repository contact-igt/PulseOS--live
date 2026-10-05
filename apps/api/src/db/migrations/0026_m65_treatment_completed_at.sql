ALTER TABLE "treatment_opportunities" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "treatment_opportunities_completed_idx" ON "treatment_opportunities" USING btree ("tenant_id","completed_at") WHERE "treatment_opportunities"."completed_at" is not null;--> statement-breakpoint
-- Backfill. A completion time is recorded ONLY where the system itself recorded the moment of completion: the
-- Timeline line the transition service writes in the same transaction as the status change ('Treatment "…" — completed').
-- It is NEVER inferred from a payment date or any other event. A COMPLETED row with no such line (data from before the
-- Timeline recorded it, or imported rows) keeps completed_at NULL: "completed, date not recorded".
UPDATE treatment_opportunities t SET completed_at = ev.at
FROM (
  SELECT related_entity_id AS id, max(occurred_at) AS at
  FROM timeline_events
  WHERE event_type = 'treatment_status_changed' AND related_entity_type = 'treatment_opportunity' AND title LIKE '% — completed'
  GROUP BY related_entity_id
) ev
WHERE ev.id = t.id AND t.status = 'COMPLETED' AND t.completed_at IS NULL;
--> statement-breakpoint
-- A completion time only ever belongs to a COMPLETED treatment (and COMPLETED is a final state).
ALTER TABLE treatment_opportunities ADD CONSTRAINT treatment_completed_at_only_when_completed CHECK (completed_at IS NULL OR status = 'COMPLETED');
