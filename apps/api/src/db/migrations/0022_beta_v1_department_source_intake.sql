-- Safety guard: the unique patient-phone indexes below must never silently fail or drop data. If a database
-- already holds two Patients with the same normalized number in one tenant, stop here and let a human merge them.
DO $$
DECLARE dup_count integer;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT 1 FROM patients WHERE phone_e164 IS NOT NULL GROUP BY tenant_id, phone_e164 HAVING count(*) > 1
    UNION ALL
    SELECT 1 FROM patients WHERE phone_e164 IS NULL GROUP BY tenant_id, phone HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'Cannot add unique patient phone indexes: % duplicate phone group(s) exist. Merge duplicate patients first.', dup_count;
  END IF;
END
$$;--> statement-breakpoint
CREATE TYPE "public"."field_origin" AS ENUM('SYSTEM', 'TEMPLATE', 'CUSTOM');--> statement-breakpoint
CREATE TYPE "public"."interaction_channel" AS ENUM('IVR_CALL', 'MANUAL_CALL', 'WHATSAPP', 'INSTAGRAM_DM', 'FACEBOOK_DM', 'WALK_IN');--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"display_name" text NOT NULL,
	"template_key" text,
	"archived" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"bucket" "source_channel" NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "patients" ALTER COLUMN "name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD COLUMN "origin" "field_origin" DEFAULT 'CUSTOM' NOT NULL;--> statement-breakpoint
ALTER TABLE "journeys" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "journeys" ADD COLUMN "department_id" uuid;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "date_of_birth" date;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "reported_age" integer;--> statement-breakpoint
ALTER TABLE "specialty_templates" ADD COLUMN "department_id" uuid;--> statement-breakpoint
ALTER TABLE "timeline_events" ADD COLUMN "channel" "interaction_channel";--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_sources" ADD CONSTRAINT "lead_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "departments_tenant_key_unique" ON "departments" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_sources_tenant_key_unique" ON "lead_sources" USING btree ("tenant_id","key");--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_source_id_lead_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."lead_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specialty_templates" ADD CONSTRAINT "specialty_templates_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "patients_tenant_phone_e164_unique" ON "patients" USING btree ("tenant_id","phone_e164") WHERE "patients"."phone_e164" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "patients_tenant_raw_phone_unique" ON "patients" USING btree ("tenant_id","phone") WHERE "patients"."phone_e164" is null;
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------------------
-- Backfills (idempotent; nothing is dropped or rewritten except the placeholder name noted below)
-- ---------------------------------------------------------------------------------------------------------

-- 1. A webhook-created caller used to be stored with the invented name "Unknown caller". Unknown is NULL now.
UPDATE patients SET name = NULL WHERE name = 'Unknown caller';--> statement-breakpoint

-- 2. Departments: every tenant that already has services from a known template gets that department, and its
--    services (and their journeys) are attached to it.
INSERT INTO departments (tenant_id, key, display_name, template_key, sort_order)
SELECT DISTINCT tenant_id, 'OPHTHALMOLOGY', 'Ophthalmology', 'ophthalmology', 0 FROM specialty_templates WHERE key IN ('CATARACT','OCULOPLASTY','LASER_VISION_CORRECTION','SQUINT','KERATOCONUS','GENERAL_EYE_CONSULTATION')
ON CONFLICT (tenant_id, key) DO NOTHING;--> statement-breakpoint
INSERT INTO departments (tenant_id, key, display_name, template_key, sort_order)
SELECT DISTINCT tenant_id, 'GYNECOLOGY', 'Gynecology', 'gynecology', 0 FROM specialty_templates WHERE key IN ('GYNECOLOGY','FERTILITY')
ON CONFLICT (tenant_id, key) DO NOTHING;--> statement-breakpoint
UPDATE specialty_templates st SET department_id = d.id FROM departments d
WHERE d.tenant_id = st.tenant_id AND d.key = 'OPHTHALMOLOGY' AND st.key IN ('CATARACT','OCULOPLASTY','LASER_VISION_CORRECTION','SQUINT','KERATOCONUS','GENERAL_EYE_CONSULTATION') AND st.department_id IS NULL;--> statement-breakpoint
UPDATE specialty_templates st SET department_id = d.id FROM departments d
WHERE d.tenant_id = st.tenant_id AND d.key = 'GYNECOLOGY' AND st.key IN ('GYNECOLOGY','FERTILITY') AND st.department_id IS NULL;--> statement-breakpoint
UPDATE journeys j SET department_id = st.department_id FROM specialty_templates st
WHERE st.tenant_id = j.tenant_id AND st.key = j.specialty_key AND j.department_id IS NULL AND st.department_id IS NOT NULL;--> statement-breakpoint

-- 3. Field origin: fields that come from a template definition are TEMPLATE; everything else stays CUSTOM.
UPDATE custom_field_definitions SET origin = 'TEMPLATE' WHERE (specialty_key, key) IN (('CATARACT','primary_eye_concern'),('CATARACT','laterality'),('CATARACT','symptom_duration'),('CATARACT','previous_eye_surgery'),('CATARACT','diabetes'),('CATARACT','glasses_or_lens_use'),('CATARACT','cataract_diagnosis'),('CATARACT','cataract_eye'),('CATARACT','cataract_surgery_advised'),('CATARACT','cataract_surgery_interest'),('OCULOPLASTY','primary_eye_concern'),('OCULOPLASTY','laterality'),('OCULOPLASTY','symptom_duration'),('OCULOPLASTY','previous_eye_surgery'),('OCULOPLASTY','diabetes'),('OCULOPLASTY','glasses_or_lens_use'),('OCULOPLASTY','oculoplasty_concern'),('OCULOPLASTY','cosmetic_or_functional'),('OCULOPLASTY','oculoplasty_procedure_advised'),('LASER_VISION_CORRECTION','primary_eye_concern'),('LASER_VISION_CORRECTION','laterality'),('LASER_VISION_CORRECTION','symptom_duration'),('LASER_VISION_CORRECTION','previous_eye_surgery'),('LASER_VISION_CORRECTION','diabetes'),('LASER_VISION_CORRECTION','glasses_or_lens_use'),('LASER_VISION_CORRECTION','lvc_interest'),('LASER_VISION_CORRECTION','spectacle_power'),('LASER_VISION_CORRECTION','lvc_contact_lens_use'),('LASER_VISION_CORRECTION','lvc_screening_completed'),('LASER_VISION_CORRECTION','lvc_eligible'),('SQUINT','primary_eye_concern'),('SQUINT','laterality'),('SQUINT','symptom_duration'),('SQUINT','previous_eye_surgery'),('SQUINT','diabetes'),('SQUINT','glasses_or_lens_use'),('SQUINT','squint_patient_group'),('SQUINT','squint_type'),('SQUINT','squint_since'),('SQUINT','squint_previous_treatment'),('SQUINT','squint_surgery_advised'),('KERATOCONUS','primary_eye_concern'),('KERATOCONUS','laterality'),('KERATOCONUS','symptom_duration'),('KERATOCONUS','previous_eye_surgery'),('KERATOCONUS','diabetes'),('KERATOCONUS','glasses_or_lens_use'),('KERATOCONUS','keratoconus_status'),('KERATOCONUS','keratoconus_eye'),('KERATOCONUS','eye_rubbing_history'),('KERATOCONUS','topography_done'),('KERATOCONUS','cxl_advised'),('GENERAL_EYE_CONSULTATION','primary_eye_concern'),('GENERAL_EYE_CONSULTATION','laterality'),('GENERAL_EYE_CONSULTATION','symptom_duration'),('GENERAL_EYE_CONSULTATION','previous_eye_surgery'),('GENERAL_EYE_CONSULTATION','diabetes'),('GENERAL_EYE_CONSULTATION','glasses_or_lens_use'),('GYNECOLOGY','pregnancy_status'),('GYNECOLOGY','gestational_week'),('GYNECOLOGY','edd'),('GYNECOLOGY','high_risk_status'),('GYNECOLOGY','previous_c_section'),('FERTILITY','trying_duration'),('FERTILITY','previous_fertility_treatment'),('FERTILITY','ivf_interest'),('FERTILITY','treatment_stage'));--> statement-breakpoint

-- 4. Lead sources: every tenant gets the Beta V1 default catalogue plus archived entries for the legacy values
--    the old single enum carried, then each journey is pointed at the entry that matches its existing value.
--    journeys.source (the coarse bucket) is untouched.
INSERT INTO lead_sources (tenant_id, key, label, bucket, archived, sort_order)
SELECT t.id, v.key, v.label, v.bucket::source_channel, v.archived, v.sort_order
FROM tenants t CROSS JOIN (VALUES
  ('instagram', 'Instagram', 'meta', false, 0),
  ('facebook', 'Facebook', 'meta', false, 1),
  ('youtube', 'YouTube', 'other', false, 2),
  ('google', 'Google', 'google', false, 3),
  ('referral', 'Referral', 'referral', false, 4),
  ('direct', 'Direct', 'organic', false, 5),
  ('walk_in', 'Walk-in', 'walk_in', false, 6),
  ('phone', 'Phone', 'phone', false, 7),
  ('whatsapp', 'WhatsApp', 'whatsapp', false, 8),
  ('other', 'Other', 'other', false, 9),
  ('meta', 'Meta ads (Facebook / Instagram)', 'meta', true, 10),
  ('website', 'Website', 'website', true, 11),
  ('organic', 'Organic', 'organic', true, 12)
) AS v(key, label, bucket, archived, sort_order)
ON CONFLICT (tenant_id, key) DO NOTHING;--> statement-breakpoint
UPDATE journeys j SET source_id = ls.id FROM lead_sources ls
WHERE ls.tenant_id = j.tenant_id AND ls.key = j.source::text AND j.source_id IS NULL;
