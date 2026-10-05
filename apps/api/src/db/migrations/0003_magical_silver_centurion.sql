CREATE TYPE "public"."conversation_channel" AS ENUM('WHATSAPP', 'CALL', 'SMS', 'EMAIL', 'INTERNAL');--> statement-breakpoint
CREATE TYPE "public"."message_sender" AS ENUM('patient', 'staff', 'ai', 'system');--> statement-breakpoint
CREATE TYPE "public"."ownership_state" AS ENUM('AI_ACTIVE', 'HUMAN_REQUIRED', 'HUMAN_ASSIGNED', 'HUMAN_ACTIVE', 'AI_RESUME_PENDING', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."task_priority" AS ENUM('normal', 'high');--> statement-breakpoint
CREATE TYPE "public"."task_type" AS ENUM('CALLBACK', 'FOLLOW_UP', 'APPOINTMENT_CONFIRMATION', 'NO_SHOW_RECOVERY', 'TREATMENT_DECISION', 'POST_CARE', 'RECALL', 'OTHER');--> statement-breakpoint
ALTER TYPE "public"."appointment_status" ADD VALUE 'requested' BEFORE 'scheduled';--> statement-breakpoint
ALTER TYPE "public"."appointment_status" ADD VALUE 'confirmed' BEFORE 'checked_in';--> statement-breakpoint
ALTER TYPE "public"."appointment_status" ADD VALUE 'waiting' BEFORE 'with_doctor';--> statement-breakpoint
ALTER TYPE "public"."treatment_status" ADD VALUE 'ACCEPTED' BEFORE 'SCHEDULED';--> statement-breakpoint
ALTER TYPE "public"."treatment_status" ADD VALUE 'CANCELLED' BEFORE 'LOST';--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"journey_id" uuid,
	"channel" "conversation_channel" DEFAULT 'WHATSAPP' NOT NULL,
	"ownership_state" "ownership_state" DEFAULT 'AI_ACTIVE' NOT NULL,
	"assigned_to" uuid,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_type" "message_sender" NOT NULL,
	"sender_user_id" uuid,
	"body" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "type" "task_type" DEFAULT 'OTHER' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "priority" "task_priority" DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "completed_by" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "treatment_opportunities" ADD COLUMN "planned_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_tenant_idx" ON "conversations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "conversations_patient_idx" ON "conversations" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_assigned_idx" ON "tasks" USING btree ("assigned_to");