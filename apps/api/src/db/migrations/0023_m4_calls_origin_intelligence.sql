CREATE TYPE "public"."call_intel_status" AS ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'NOT_CONFIGURED');--> statement-breakpoint
CREATE TYPE "public"."call_origin" AS ENUM('IVR', 'MANUAL');--> statement-breakpoint
CREATE TABLE "call_intelligence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"transcript_status" "call_intel_status" DEFAULT 'PENDING' NOT NULL,
	"transcript" text,
	"transcript_provider" text,
	"transcript_mode" text,
	"summary_status" "call_intel_status" DEFAULT 'PENDING' NOT NULL,
	"summary" text,
	"summary_details" jsonb,
	"summary_provider" text,
	"summary_mode" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"generated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calls" ALTER COLUMN "connector_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ALTER COLUMN "external_call_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "origin" "call_origin" DEFAULT 'IVR' NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "staff_feedback" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "feedback_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "feedback_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "outcome_id" uuid;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "logged_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "callback_task_id" uuid;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "call_intelligence" ADD CONSTRAINT "call_intelligence_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_intelligence" ADD CONSTRAINT "call_intelligence_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "call_intelligence_call_unique" ON "call_intelligence" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "call_intelligence_due_idx" ON "call_intelligence" USING btree ("transcript_status","summary_status","next_attempt_at");--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_feedback_by_user_id_users_id_fk" FOREIGN KEY ("feedback_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_outcome_id_crm_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."crm_outcomes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_logged_by_user_id_users_id_fk" FOREIGN KEY ("logged_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_callback_task_id_tasks_id_fk" FOREIGN KEY ("callback_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calls_journey_idx" ON "calls" USING btree ("journey_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calls_tenant_idempotency_unique" ON "calls" USING btree ("tenant_id","idempotency_key") WHERE "calls"."idempotency_key" is not null;