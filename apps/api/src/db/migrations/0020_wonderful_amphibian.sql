CREATE TABLE "conversation_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"journey_id" uuid,
	"segment_no" integer NOT NULL,
	"first_message_id" uuid NOT NULL,
	"last_message_id" uuid NOT NULL,
	"first_message_at" timestamp with time zone NOT NULL,
	"last_message_at" timestamp with time zone NOT NULL,
	"message_count" integer NOT NULL,
	"summary" text NOT NULL,
	"patient_intent" text,
	"service_interest" text,
	"questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outcome" text,
	"promised_action" text,
	"next_action" text,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider" text NOT NULL,
	"mode" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"conversation_idle_minutes" integer DEFAULT 7 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "summary_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "summary_state" text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "summary_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "summary_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "summary_error" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "last_patient_inbound_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_first_message_id_messages_id_fk" FOREIGN KEY ("first_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_last_message_id_messages_id_fk" FOREIGN KEY ("last_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_summaries_conversation_idx" ON "conversation_summaries" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "conversation_summaries_patient_idx" ON "conversation_summaries" USING btree ("patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_summaries_session_unique" ON "conversation_summaries" USING btree ("conversation_id","last_message_id");--> statement-breakpoint
CREATE INDEX "conversations_summary_due_idx" ON "conversations" USING btree ("summary_due_at");--> statement-breakpoint
UPDATE "conversations" c SET "last_patient_inbound_at" = (SELECT max(m."sent_at") FROM "messages" m WHERE m."conversation_id" = c."id" AND m."sender_type" = 'patient');
