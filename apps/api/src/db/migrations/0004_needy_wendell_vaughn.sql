CREATE TYPE "public"."call_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."call_status" AS ENUM('completed', 'missed', 'no_answer', 'busy', 'failed');--> statement-breakpoint
CREATE TYPE "public"."connector_capability" AS ENUM('SEND_MESSAGE', 'RECEIVE_MESSAGE', 'RECEIVE_STATUS', 'INITIATE_CALL', 'RECEIVE_CALL_EVENT', 'FETCH_RECORDING', 'RECEIVE_RECORDING', 'RECEIVE_TRANSCRIPT');--> statement-breakpoint
CREATE TYPE "public"."connector_event_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."connector_event_status" AS ENUM('received', 'processed', 'failed', 'duplicate');--> statement-breakpoint
CREATE TYPE "public"."connector_status" AS ENUM('NOT_CONFIGURED', 'CONNECTING', 'CONNECTED', 'DEGRADED', 'ERROR', 'DISABLED');--> statement-breakpoint
CREATE TYPE "public"."connector_type" AS ENUM('MESSAGING', 'TELEPHONY', 'ADS', 'EMAIL', 'STORAGE', 'HIS');--> statement-breakpoint
CREATE TYPE "public"."message_delivery_status" AS ENUM('queued', 'sent', 'delivered', 'read', 'failed');--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"patient_id" uuid,
	"journey_id" uuid,
	"external_call_id" text NOT NULL,
	"direction" "call_direction" NOT NULL,
	"phone" text NOT NULL,
	"status" "call_status" NOT NULL,
	"duration_seconds" integer,
	"recording_url" text,
	"disposition" text,
	"agent_name" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"external_event_id" text NOT NULL,
	"direction" "connector_event_direction" NOT NULL,
	"status" "connector_event_status" DEFAULT 'received' NOT NULL,
	"error" text,
	"payload" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "connector_secrets" (
	"connector_id" uuid PRIMARY KEY NOT NULL,
	"encrypted_payload" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" "connector_type" NOT NULL,
	"provider" text NOT NULL,
	"status" "connector_status" DEFAULT 'NOT_CONFIGURED' NOT NULL,
	"display_name" text NOT NULL,
	"capabilities" "connector_capability"[] NOT NULL,
	"configuration" jsonb,
	"last_sync_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "connector_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "external_thread_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "connector_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "provider_message_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "delivery_status" "message_delivery_status";--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_events" ADD CONSTRAINT "connector_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_events" ADD CONSTRAINT "connector_events_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_secrets" ADD CONSTRAINT "connector_secrets_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calls_tenant_idx" ON "calls" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "calls_patient_idx" ON "calls" USING btree ("patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calls_connector_external_unique" ON "calls" USING btree ("connector_id","external_call_id");--> statement-breakpoint
CREATE INDEX "connector_events_connector_idx" ON "connector_events" USING btree ("connector_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_events_connector_external_unique" ON "connector_events" USING btree ("connector_id","external_event_id");--> statement-breakpoint
CREATE INDEX "connectors_tenant_idx" ON "connectors" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connectors_tenant_provider_unique" ON "connectors" USING btree ("tenant_id","provider");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_connector_external_thread_unique" ON "conversations" USING btree ("connector_id","external_thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_connector_provider_message_unique" ON "messages" USING btree ("connector_id","provider_message_id");