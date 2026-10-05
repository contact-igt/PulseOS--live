CREATE TYPE "public"."connector_audit_action" AS ENUM('CREATE', 'UPDATE', 'DELETE');--> statement-breakpoint
CREATE TYPE "public"."connector_mode" AS ENUM('FIXTURE', 'SANDBOX', 'LIVE');--> statement-breakpoint
CREATE TYPE "public"."conversion_feedback_event_type" AS ENUM('QUALIFIED_ENQUIRY', 'APPOINTMENT_BOOKED', 'APPOINTMENT_ATTENDED', 'CONSULTATION_COMPLETED', 'TREATMENT_ADVISED', 'TREATMENT_COMPLETED', 'REVENUE_RECORDED');--> statement-breakpoint
CREATE TYPE "public"."disposition_action" AS ENUM('CREATE_CALLBACK_TASK', 'ADVANCE_JOURNEY_STAGE');--> statement-breakpoint
ALTER TYPE "public"."connector_capability" ADD VALUE 'RECEIVE_LEAD';--> statement-breakpoint
ALTER TYPE "public"."connector_capability" ADD VALUE 'SYNC_CAMPAIGNS';--> statement-breakpoint
ALTER TYPE "public"."connector_capability" ADD VALUE 'SYNC_AD_GROUPS';--> statement-breakpoint
ALTER TYPE "public"."connector_capability" ADD VALUE 'SYNC_ADS';--> statement-breakpoint
ALTER TYPE "public"."connector_capability" ADD VALUE 'SYNC_SPEND';--> statement-breakpoint
ALTER TYPE "public"."connector_capability" ADD VALUE 'SYNC_PERFORMANCE';--> statement-breakpoint
ALTER TYPE "public"."connector_capability" ADD VALUE 'RECEIVE_FORM';--> statement-breakpoint
ALTER TYPE "public"."connector_capability" ADD VALUE 'EXPORT_CONVERSION';--> statement-breakpoint
ALTER TYPE "public"."connector_type" ADD VALUE 'ACQUISITION';--> statement-breakpoint
CREATE TABLE "connector_config_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" "connector_audit_action" NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_disposition_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"provider_disposition" text NOT NULL,
	"action" "disposition_action" NOT NULL,
	"action_config" jsonb NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversion_feedback_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"journey_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"event_type" "conversion_feedback_event_type" NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value" integer,
	"currency" text DEFAULT 'INR' NOT NULL,
	"source" "source_channel",
	"external_campaign_id" text,
	"gclid" text,
	"gbraid" text,
	"wbraid" text,
	"fbclid" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gbp_performance_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"metric_date" timestamp with time zone NOT NULL,
	"impressions" integer,
	"clicks" integer,
	"search_impressions" integer,
	"website_clicks" integer,
	"call_clicks" integer,
	"direction_requests" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_touchpoints" ADD COLUMN "medium" text;--> statement-breakpoint
ALTER TABLE "campaign_touchpoints" ADD COLUMN "utm_campaign" text;--> statement-breakpoint
ALTER TABLE "campaign_touchpoints" ADD COLUMN "utm_content" text;--> statement-breakpoint
ALTER TABLE "campaign_touchpoints" ADD COLUMN "utm_term" text;--> statement-breakpoint
ALTER TABLE "campaign_touchpoints" ADD COLUMN "external_account_id" text;--> statement-breakpoint
ALTER TABLE "campaign_touchpoints" ADD COLUMN "external_campaign_id" text;--> statement-breakpoint
ALTER TABLE "campaign_touchpoints" ADD COLUMN "external_ad_group_id" text;--> statement-breakpoint
ALTER TABLE "campaign_touchpoints" ADD COLUMN "external_ad_id" text;--> statement-breakpoint
ALTER TABLE "campaign_touchpoints" ADD COLUMN "external_form_id" text;--> statement-breakpoint
ALTER TABLE "campaign_touchpoints" ADD COLUMN "external_lead_id" text;--> statement-breakpoint
ALTER TABLE "campaign_touchpoints" ADD COLUMN "gclid" text;--> statement-breakpoint
ALTER TABLE "campaign_touchpoints" ADD COLUMN "gbraid" text;--> statement-breakpoint
ALTER TABLE "campaign_touchpoints" ADD COLUMN "wbraid" text;--> statement-breakpoint
ALTER TABLE "campaign_touchpoints" ADD COLUMN "fbclid" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "mode" "connector_mode" DEFAULT 'FIXTURE' NOT NULL;--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD COLUMN "connector_id" uuid;--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD COLUMN "external_account_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "default_phone_region" text DEFAULT 'IN' NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_config_audit_events" ADD CONSTRAINT "connector_config_audit_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_config_audit_events" ADD CONSTRAINT "connector_config_audit_events_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_config_audit_events" ADD CONSTRAINT "connector_config_audit_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_disposition_mappings" ADD CONSTRAINT "connector_disposition_mappings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_disposition_mappings" ADD CONSTRAINT "connector_disposition_mappings_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_disposition_mappings" ADD CONSTRAINT "connector_disposition_mappings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_disposition_mappings" ADD CONSTRAINT "connector_disposition_mappings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_feedback_events" ADD CONSTRAINT "conversion_feedback_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_feedback_events" ADD CONSTRAINT "conversion_feedback_events_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_feedback_events" ADD CONSTRAINT "conversion_feedback_events_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gbp_performance_metrics" ADD CONSTRAINT "gbp_performance_metrics_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gbp_performance_metrics" ADD CONSTRAINT "gbp_performance_metrics_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connector_audit_connector_idx" ON "connector_config_audit_events" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX "disposition_mappings_connector_idx" ON "connector_disposition_mappings" USING btree ("connector_id");--> statement-breakpoint
CREATE UNIQUE INDEX "disposition_mappings_connector_disposition_unique" ON "connector_disposition_mappings" USING btree ("connector_id","provider_disposition");--> statement-breakpoint
CREATE INDEX "conversion_feedback_events_tenant_idx" ON "conversion_feedback_events" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversion_feedback_events_idempotency_unique" ON "conversion_feedback_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "gbp_performance_metrics_tenant_idx" ON "gbp_performance_metrics" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gbp_performance_metrics_connector_date_unique" ON "gbp_performance_metrics" USING btree ("connector_id","metric_date");--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "marketing_campaigns_tenant_external_unique" ON "marketing_campaigns" USING btree ("tenant_id","external_campaign_id");