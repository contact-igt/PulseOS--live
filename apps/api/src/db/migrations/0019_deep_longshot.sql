CREATE TABLE "allocation_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"match_source" text,
	"match_specialty_key" text,
	"match_journey_type" text,
	"match_branch_id" uuid,
	"pool" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rr_cursor" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "allocation_rules" ADD CONSTRAINT "allocation_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_rules" ADD CONSTRAINT "allocation_rules_match_branch_id_branches_id_fk" FOREIGN KEY ("match_branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "allocation_rules_tenant_idx" ON "allocation_rules" USING btree ("tenant_id");