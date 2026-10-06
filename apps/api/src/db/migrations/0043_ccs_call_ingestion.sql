ALTER TABLE "communication_endpoints" ADD COLUMN "lead_source_id" uuid;--> statement-breakpoint
ALTER TABLE "communication_endpoints" ADD COLUMN "source_detail" text;--> statement-breakpoint
ALTER TABLE "communication_endpoints" ADD COLUMN "department_id" uuid;--> statement-breakpoint
ALTER TABLE "journeys" ADD COLUMN "source_detail" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "handled_by_user_id" uuid;--> statement-breakpoint
CREATE TABLE "connector_agent_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"external_agent" text NOT NULL,
	"external_key" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "communication_endpoints" ADD CONSTRAINT "communication_endpoints_lead_source_id_lead_sources_id_fk" FOREIGN KEY ("lead_source_id") REFERENCES "public"."lead_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_endpoints" ADD CONSTRAINT "communication_endpoints_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_handled_by_user_id_users_id_fk" FOREIGN KEY ("handled_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_agent_mappings" ADD CONSTRAINT "connector_agent_mappings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_agent_mappings" ADD CONSTRAINT "connector_agent_mappings_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_agent_mappings" ADD CONSTRAINT "connector_agent_mappings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_agent_mappings_connector_key_unique" ON "connector_agent_mappings" USING btree ("connector_id","external_key");--> statement-breakpoint
CREATE INDEX "connector_agent_mappings_tenant_idx" ON "connector_agent_mappings" USING btree ("tenant_id");
