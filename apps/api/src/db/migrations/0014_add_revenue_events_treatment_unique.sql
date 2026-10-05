-- Defense-in-depth dedup before the unique index below: any environment that
-- already accumulated a duplicate treatment_opportunity_id (e.g. from the
-- check-then-act race this index exists to backstop, before it was fixed, or
-- from manually re-run demo/seed data) would otherwise make this migration
-- hard-fail with "could not create unique index" and block every migration
-- after it. Keeps the oldest row per treatment_opportunity_id, matching
-- "the first completion wins" semantics already established in application
-- code (treatment.service.ts's conditional-UPDATE guard).
DELETE FROM "revenue_events" a USING "revenue_events" b
  WHERE a."treatment_opportunity_id" = b."treatment_opportunity_id"
    AND a."treatment_opportunity_id" IS NOT NULL
    AND a."id" > b."id";--> statement-breakpoint
CREATE UNIQUE INDEX "revenue_events_treatment_opportunity_unique" ON "revenue_events" USING btree ("treatment_opportunity_id");