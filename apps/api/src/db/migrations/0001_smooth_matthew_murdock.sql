CREATE TYPE "public"."actor_type" AS ENUM('system', 'ai', 'user');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('active', 'paused', 'ended');--> statement-breakpoint
CREATE TYPE "public"."consultation_outcome_type" AS ENUM('CONSULTED', 'TREATMENT_ADVISED', 'NO_TREATMENT_REQUIRED', 'DECISION_PENDING', 'FOLLOW_UP_REQUIRED', 'REFERRED', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."revenue_event_type" AS ENUM('consultation_fee', 'treatment_payment', 'other');--> statement-breakpoint
CREATE TYPE "public"."touch_type" AS ENUM('first_touch', 'last_touch');--> statement-breakpoint
CREATE TYPE "public"."treatment_status" AS ENUM('ADVISED', 'DECISION_PENDING', 'SCHEDULED', 'COMPLETED', 'DECLINED', 'LOST');--> statement-breakpoint
CREATE TABLE "campaign_touchpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"journey_id" uuid NOT NULL,
	"campaign_id" uuid,
	"source" "source_channel" NOT NULL,
	"touch_type" "touch_type" DEFAULT 'first_touch' NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "consultation_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"journey_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"outcome" "consultation_outcome_type" NOT NULL,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "marketing_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source" "source_channel" NOT NULL,
	"name" text NOT NULL,
	"external_campaign_id" text,
	"spend_amount" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"start_date" timestamp with time zone NOT NULL,
	"end_date" timestamp with time zone,
	"status" "campaign_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revenue_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"journey_id" uuid NOT NULL,
	"treatment_opportunity_id" uuid,
	"amount" integer NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"type" "revenue_event_type" DEFAULT 'treatment_payment' NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_system" text DEFAULT 'manual' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timeline_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"journey_id" uuid,
	"actor_type" "actor_type" DEFAULT 'system' NOT NULL,
	"actor_id" uuid,
	"event_type" text NOT NULL,
	"source_channel" text,
	"title" text NOT NULL,
	"description" text,
	"related_entity_type" text,
	"related_entity_id" uuid,
	"metadata" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "treatment_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"journey_id" uuid NOT NULL,
	"consultation_outcome_id" uuid,
	"treatment_label" text NOT NULL,
	"status" "treatment_status" DEFAULT 'ADVISED' NOT NULL,
	"estimated_value" integer DEFAULT 0 NOT NULL,
	"owner_user_id" uuid,
	"decision_date" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_touchpoints" ADD CONSTRAINT "campaign_touchpoints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_touchpoints" ADD CONSTRAINT "campaign_touchpoints_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_touchpoints" ADD CONSTRAINT "campaign_touchpoints_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_touchpoints" ADD CONSTRAINT "campaign_touchpoints_campaign_id_marketing_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."marketing_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultation_outcomes" ADD CONSTRAINT "consultation_outcomes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultation_outcomes" ADD CONSTRAINT "consultation_outcomes_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultation_outcomes" ADD CONSTRAINT "consultation_outcomes_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultation_outcomes" ADD CONSTRAINT "consultation_outcomes_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultation_outcomes" ADD CONSTRAINT "consultation_outcomes_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_campaigns" ADD CONSTRAINT "marketing_campaigns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_events" ADD CONSTRAINT "revenue_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_events" ADD CONSTRAINT "revenue_events_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_events" ADD CONSTRAINT "revenue_events_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_events" ADD CONSTRAINT "revenue_events_treatment_opportunity_id_treatment_opportunities_id_fk" FOREIGN KEY ("treatment_opportunity_id") REFERENCES "public"."treatment_opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_events" ADD CONSTRAINT "timeline_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_events" ADD CONSTRAINT "timeline_events_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_events" ADD CONSTRAINT "timeline_events_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_opportunities" ADD CONSTRAINT "treatment_opportunities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_opportunities" ADD CONSTRAINT "treatment_opportunities_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_opportunities" ADD CONSTRAINT "treatment_opportunities_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_opportunities" ADD CONSTRAINT "treatment_opportunities_consultation_outcome_id_consultation_outcomes_id_fk" FOREIGN KEY ("consultation_outcome_id") REFERENCES "public"."consultation_outcomes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_opportunities" ADD CONSTRAINT "treatment_opportunities_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_touchpoints_tenant_idx" ON "campaign_touchpoints" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "campaign_touchpoints_journey_idx" ON "campaign_touchpoints" USING btree ("journey_id");--> statement-breakpoint
CREATE INDEX "campaign_touchpoints_campaign_idx" ON "campaign_touchpoints" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "consultation_outcomes_tenant_idx" ON "consultation_outcomes" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "consultation_outcomes_appointment_unique" ON "consultation_outcomes" USING btree ("appointment_id");--> statement-breakpoint
CREATE INDEX "marketing_campaigns_tenant_idx" ON "marketing_campaigns" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "revenue_events_tenant_idx" ON "revenue_events" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "revenue_events_journey_idx" ON "revenue_events" USING btree ("journey_id");--> statement-breakpoint
CREATE INDEX "timeline_events_tenant_idx" ON "timeline_events" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "timeline_events_patient_idx" ON "timeline_events" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "timeline_events_journey_idx" ON "timeline_events" USING btree ("journey_id");--> statement-breakpoint
CREATE INDEX "timeline_events_occurred_idx" ON "timeline_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "treatment_opportunities_tenant_idx" ON "treatment_opportunities" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "treatment_opportunities_journey_idx" ON "treatment_opportunities" USING btree ("journey_id");--> statement-breakpoint
ALTER TABLE "appointments" DROP COLUMN "outcome_recorded";--> statement-breakpoint
ALTER TABLE "appointments" DROP COLUMN "treatment_recommended";--> statement-breakpoint
ALTER TABLE "appointments" DROP COLUMN "revenue_amount";