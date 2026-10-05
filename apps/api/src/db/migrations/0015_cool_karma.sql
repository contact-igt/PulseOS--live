CREATE TABLE "treatment_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"specialty_key" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"default_estimated_value" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "treatment_opportunities" ADD COLUMN "treatment_definition_id" uuid;--> statement-breakpoint
ALTER TABLE "treatment_definitions" ADD CONSTRAINT "treatment_definitions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "treatment_definitions_tenant_specialty_idx" ON "treatment_definitions" USING btree ("tenant_id","specialty_key");--> statement-breakpoint
CREATE UNIQUE INDEX "treatment_definitions_tenant_key_unique" ON "treatment_definitions" USING btree ("tenant_id","key");--> statement-breakpoint
ALTER TABLE "treatment_opportunities" ADD CONSTRAINT "treatment_opportunities_treatment_definition_id_treatment_definitions_id_fk" FOREIGN KEY ("treatment_definition_id") REFERENCES "public"."treatment_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "treatment_opportunities_definition_idx" ON "treatment_opportunities" USING btree ("treatment_definition_id");