CREATE TYPE "public"."followup_default_owner" AS ENUM('JOURNEY_OWNER', 'ACTOR', 'UNASSIGNED');--> statement-breakpoint
CREATE TABLE "followup_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"department_id" uuid,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"canonical_task_type" "task_type" DEFAULT 'FOLLOW_UP' NOT NULL,
	"default_priority" "task_priority" DEFAULT 'normal' NOT NULL,
	"default_owner" "followup_default_owner" DEFAULT 'JOURNEY_OWNER' NOT NULL,
	"requires_note" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "followup_type_id" uuid;--> statement-breakpoint
ALTER TABLE "followup_types" ADD CONSTRAINT "followup_types_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "followup_types" ADD CONSTRAINT "followup_types_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "followup_types_tenant_key_unique" ON "followup_types" USING btree ("tenant_id","key");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_followup_type_id_followup_types_id_fk" FOREIGN KEY ("followup_type_id") REFERENCES "public"."followup_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_journey_idx" ON "tasks" USING btree ("journey_id");--> statement-breakpoint
-- Backfill: every tenant gets the five default follow-up types (applies to all departments); existing tasks are linked
-- to the type that matches their canonical type. Tasks of other canonical types keep no follow-up type (they render
-- with their stable label as before).
INSERT INTO followup_types (tenant_id, key, label, canonical_task_type, default_priority, default_owner, requires_note, sort_order)
SELECT t.id, v.key, v.label, v.canonical::task_type, v.priority::task_priority, 'JOURNEY_OWNER', v.requires_note, v.sort_order
FROM tenants t CROSS JOIN (VALUES
  ('callback', 'Callback', 'CALLBACK', 'normal', false, 0),
  ('appointment_followup', 'Appointment Follow-up', 'FOLLOW_UP', 'normal', false, 1),
  ('appointment_risk', 'Appointment Risk', 'FOLLOW_UP', 'high', true, 2),
  ('general_followup', 'General Follow-up', 'FOLLOW_UP', 'normal', false, 3),
  ('surgery_followup', 'Surgery Follow-up', 'FOLLOW_UP', 'normal', false, 4)
) AS v(key, label, canonical, priority, requires_note, sort_order)
ON CONFLICT (tenant_id, key) DO NOTHING;--> statement-breakpoint
UPDATE tasks tk SET followup_type_id = ft.id FROM followup_types ft
WHERE ft.tenant_id = tk.tenant_id AND ft.key = 'callback' AND tk.type = 'CALLBACK' AND tk.followup_type_id IS NULL;--> statement-breakpoint
UPDATE tasks tk SET followup_type_id = ft.id FROM followup_types ft
WHERE ft.tenant_id = tk.tenant_id AND ft.key = 'general_followup' AND tk.type = 'FOLLOW_UP' AND tk.followup_type_id IS NULL;
