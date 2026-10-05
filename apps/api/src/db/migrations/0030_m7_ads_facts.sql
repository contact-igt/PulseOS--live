CREATE TABLE "ads_daily_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"account_id" text NOT NULL,
	"entity_type" text DEFAULT 'CAMPAIGN' NOT NULL,
	"entity_id" text NOT NULL,
	"entity_name" text NOT NULL,
	"fact_date" date NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"spend" numeric(14, 2) DEFAULT '0' NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"provider_conversions" numeric(14, 2),
	"actions" jsonb,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ads_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"range_from" date NOT NULL,
	"range_to" date NOT NULL,
	"rows_upserted" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ads_daily_facts" ADD CONSTRAINT "ads_daily_facts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads_daily_facts" ADD CONSTRAINT "ads_daily_facts_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads_sync_runs" ADD CONSTRAINT "ads_sync_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads_sync_runs" ADD CONSTRAINT "ads_sync_runs_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ads_daily_facts_natural_unique" ON "ads_daily_facts" USING btree ("tenant_id","provider","account_id","entity_type","entity_id","fact_date");--> statement-breakpoint
CREATE INDEX "ads_daily_facts_range_idx" ON "ads_daily_facts" USING btree ("tenant_id","provider","fact_date");--> statement-breakpoint
CREATE INDEX "ads_sync_runs_tenant_provider_idx" ON "ads_sync_runs" USING btree ("tenant_id","provider","started_at");