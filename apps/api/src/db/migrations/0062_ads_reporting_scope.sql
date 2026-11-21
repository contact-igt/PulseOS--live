ALTER TABLE "ads_daily_facts" ADD COLUMN "mode" "connector_mode";--> statement-breakpoint
ALTER TABLE "ads_sync_runs" ADD COLUMN "mode" "connector_mode";--> statement-breakpoint
ALTER TABLE "ads_sync_runs" ADD COLUMN "account_id" text;
