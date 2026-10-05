CREATE TABLE "crm_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"stage" text DEFAULT 'contacted' NOT NULL,
	"requires_follow_up" boolean DEFAULT false NOT NULL,
	"allows_appointment" boolean DEFAULT false NOT NULL,
	"asks_reason" boolean DEFAULT false NOT NULL,
	"follow_up_type" text DEFAULT 'FOLLOW_UP' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "journeys" ADD COLUMN "last_outcome_id" uuid;--> statement-breakpoint
ALTER TABLE "journeys" ADD COLUMN "last_outcome_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "crm_outcomes" ADD CONSTRAINT "crm_outcomes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crm_outcomes_tenant_idx" ON "crm_outcomes" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_outcomes_tenant_key_unique" ON "crm_outcomes" USING btree ("tenant_id","key");--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_last_outcome_id_crm_outcomes_id_fk" FOREIGN KEY ("last_outcome_id") REFERENCES "public"."crm_outcomes"("id") ON DELETE no action ON UPDATE no action;