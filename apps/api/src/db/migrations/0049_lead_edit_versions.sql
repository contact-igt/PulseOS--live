-- Edit Lead refuses a save made on a stale copy of the patient or journey: each row says when it last changed.
ALTER TABLE "patients" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone NOT NULL DEFAULT now();
ALTER TABLE "journeys" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone NOT NULL DEFAULT now();
