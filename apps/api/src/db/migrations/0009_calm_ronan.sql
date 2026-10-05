ALTER TABLE "patients" ADD COLUMN "phone_e164" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "phone_country" text;--> statement-breakpoint
CREATE INDEX "patients_phone_e164_idx" ON "patients" USING btree ("phone_e164");