CREATE TYPE "public"."communication_endpoint_type" AS ENUM('PHONE', 'WHATSAPP');--> statement-breakpoint
CREATE TABLE "communication_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"branch_id" uuid,
	"type" "communication_endpoint_type" NOT NULL,
	"provider" text NOT NULL,
	"public_number" text NOT NULL,
	"provider_ref" text NOT NULL,
	"display_label" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "conversations_connector_external_thread_unique";--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "communication_endpoint_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "communication_endpoint_id" uuid;--> statement-breakpoint
ALTER TABLE "communication_endpoints" ADD CONSTRAINT "communication_endpoints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_endpoints" ADD CONSTRAINT "communication_endpoints_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_endpoints" ADD CONSTRAINT "communication_endpoints_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "communication_endpoints_tenant_idx" ON "communication_endpoints" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "communication_endpoints_connector_provider_ref_unique" ON "communication_endpoints" USING btree ("connector_id","provider_ref");--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_communication_endpoint_id_communication_endpoints_id_fk" FOREIGN KEY ("communication_endpoint_id") REFERENCES "public"."communication_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_communication_endpoint_id_communication_endpoints_id_fk" FOREIGN KEY ("communication_endpoint_id") REFERENCES "public"."communication_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_connector_endpoint_external_thread_unique" ON "conversations" USING btree ("connector_id","communication_endpoint_id","external_thread_id");