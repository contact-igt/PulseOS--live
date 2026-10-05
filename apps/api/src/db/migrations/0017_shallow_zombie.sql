ALTER TYPE "public"."custom_field_type" ADD VALUE 'LONG_TEXT';--> statement-breakpoint
ALTER TYPE "public"."custom_field_type" ADD VALUE 'EMAIL';--> statement-breakpoint
ALTER TYPE "public"."custom_field_type" ADD VALUE 'DATETIME';--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD COLUMN "group_key" text DEFAULT 'enquiry_details' NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD COLUMN "placements" jsonb DEFAULT '["add_lead","journey_detail","patient_360"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD COLUMN "default_value" jsonb;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD COLUMN "visible_to" text DEFAULT 'everyone' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_definitions_tenant_specialty_key_unique" ON "custom_field_definitions" USING btree ("tenant_id","specialty_key","key");