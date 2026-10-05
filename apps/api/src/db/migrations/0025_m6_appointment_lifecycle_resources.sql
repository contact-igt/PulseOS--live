CREATE TABLE "schedule_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"department_id" uuid,
	"linked_user_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appointments" ALTER COLUMN "doctor_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "resource_id" uuid;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "checked_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "waiting_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "consultation_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "no_show_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "status_reason_code" text;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "status_reason_note" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "appointment_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "risk_reason" text;--> statement-breakpoint
ALTER TABLE "treatment_opportunities" ADD COLUMN "scheduled_resource_id" uuid;--> statement-breakpoint
ALTER TABLE "treatment_opportunities" ADD COLUMN "scheduled_branch_id" uuid;--> statement-breakpoint
ALTER TABLE "treatment_opportunities" ADD COLUMN "schedule_note" text;--> statement-breakpoint
ALTER TABLE "schedule_resources" ADD CONSTRAINT "schedule_resources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_resources" ADD CONSTRAINT "schedule_resources_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_resources" ADD CONSTRAINT "schedule_resources_linked_user_id_users_id_fk" FOREIGN KEY ("linked_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedule_resources_tenant_idx" ON "schedule_resources" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_resources_tenant_user_unique" ON "schedule_resources" USING btree ("tenant_id","linked_user_id") WHERE "schedule_resources"."linked_user_id" is not null;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_resource_id_schedule_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."schedule_resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_opportunities" ADD CONSTRAINT "treatment_opportunities_scheduled_resource_id_schedule_resources_id_fk" FOREIGN KEY ("scheduled_resource_id") REFERENCES "public"."schedule_resources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_opportunities" ADD CONSTRAINT "treatment_opportunities_scheduled_branch_id_branches_id_fk" FOREIGN KEY ("scheduled_branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointments_resource_idx" ON "appointments" USING btree ("resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_open_appointment_risk_unique" ON "tasks" USING btree ("appointment_id","risk_reason") WHERE "tasks"."appointment_id" is not null and "tasks"."risk_reason" is not null and "tasks"."status" in ('pending', 'in_progress');--> statement-breakpoint
-- Resources: a doctor is a scheduling profile, not a login. Every DOCTOR user (and anyone an appointment already points
-- at) gets a linked resource; unlinked resources can be added later for doctors who never sign in.
CREATE FUNCTION ensure_user_resource(p_user_id uuid) RETURNS uuid AS $$
DECLARE
  v_id uuid;
  v_tenant uuid;
  v_name text;
BEGIN
  SELECT tenant_id, name INTO v_tenant, v_name FROM users WHERE id = p_user_id;
  IF v_tenant IS NULL THEN RETURN NULL; END IF;
  SELECT id INTO v_id FROM schedule_resources WHERE tenant_id = v_tenant AND linked_user_id = p_user_id;
  IF v_id IS NULL THEN
    INSERT INTO schedule_resources (tenant_id, name, linked_user_id) VALUES (v_tenant, v_name, p_user_id)
    ON CONFLICT (tenant_id, linked_user_id) WHERE linked_user_id IS NOT NULL DO UPDATE SET name = EXCLUDED.name
    RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
INSERT INTO schedule_resources (tenant_id, name, linked_user_id)
SELECT u.tenant_id, u.name, u.id FROM users u
WHERE u.role = 'DOCTOR' OR u.id IN (SELECT doctor_user_id FROM appointments WHERE doctor_user_id IS NOT NULL)
ON CONFLICT (tenant_id, linked_user_id) WHERE linked_user_id IS NOT NULL DO NOTHING;
--> statement-breakpoint
UPDATE appointments a SET resource_id = r.id FROM schedule_resources r WHERE r.tenant_id = a.tenant_id AND r.linked_user_id = a.doctor_user_id AND a.resource_id IS NULL;
--> statement-breakpoint
-- Arrival times: the check-in the Timeline already recorded becomes the real timestamp for visits still in flight or done.
UPDATE appointments a SET checked_in_at = (
  SELECT max(t.occurred_at) FROM timeline_events t
  WHERE t.tenant_id = a.tenant_id AND t.patient_id = a.patient_id AND t.journey_id = a.journey_id AND t.event_type = 'appointment_checked_in'
) WHERE a.status::text IN ('checked_in', 'waiting', 'with_doctor', 'completed');
--> statement-breakpoint
CREATE FUNCTION users_sync_resource() RETURNS trigger AS $$
BEGIN
  IF NEW.role = 'DOCTOR' THEN
    PERFORM ensure_user_resource(NEW.id);
  END IF;
  UPDATE schedule_resources SET name = NEW.name WHERE tenant_id = NEW.tenant_id AND linked_user_id = NEW.id AND name <> NEW.name;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER users_sync_resource_trg AFTER INSERT OR UPDATE OF role, name ON users FOR EACH ROW EXECUTE FUNCTION users_sync_resource();
--> statement-breakpoint
-- An appointment's resource and its login stay in step: writers that only know the doctor's user id (older code, tests)
-- resolve to that user's resource; a resource from another hospital is refused outright.
CREATE FUNCTION appointments_resolve_resource() RETURNS trigger AS $$
DECLARE
  v_tenant uuid;
  v_user uuid;
BEGIN
  IF NEW.resource_id IS NULL AND NEW.doctor_user_id IS NOT NULL THEN
    NEW.resource_id := ensure_user_resource(NEW.doctor_user_id);
  END IF;
  IF NEW.resource_id IS NOT NULL THEN
    SELECT tenant_id, linked_user_id INTO v_tenant, v_user FROM schedule_resources WHERE id = NEW.resource_id;
    IF v_tenant IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'appointment resource belongs to another hospital' USING ERRCODE = '23514';
    END IF;
    NEW.doctor_user_id := v_user;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER appointments_resolve_resource_trg BEFORE INSERT OR UPDATE OF resource_id, doctor_user_id ON appointments FOR EACH ROW EXECUTE FUNCTION appointments_resolve_resource();
--> statement-breakpoint
ALTER TABLE appointments ADD CONSTRAINT appointments_resource_required CHECK (resource_id IS NOT NULL);
