CREATE TYPE "public"."conversation_automation_mode" AS ENUM('manual', 'ai_when_available', 'ai_scheduled');--> statement-breakpoint
CREATE TABLE "conversation_automation_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"mode" "conversation_automation_mode" DEFAULT 'manual' NOT NULL,
	"scheduled_start" timestamp with time zone,
	"scheduled_end" timestamp with time zone,
	"timezone" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_automation_preferences" ADD CONSTRAINT "conversation_automation_preferences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_automation_preferences" ADD CONSTRAINT "conversation_automation_preferences_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_automation_preferences" ADD CONSTRAINT "conversation_automation_preferences_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_automation_preferences_tenant_idx" ON "conversation_automation_preferences" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_automation_preferences_conversation_unique" ON "conversation_automation_preferences" USING btree ("conversation_id");