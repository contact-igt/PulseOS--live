ALTER TABLE tenants ADD COLUMN lifecycle_status text NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN lifecycle_version integer NOT NULL DEFAULT 0,
  ADD COLUMN lifecycle_changed_at timestamptz;
--> statement-breakpoint
UPDATE tenants SET lifecycle_status = 'PROVISIONING' WHERE NOT login_enabled;
--> statement-breakpoint
ALTER TABLE tenants ADD CONSTRAINT tenants_lifecycle_status_check
  CHECK (lifecycle_status IN ('PROVISIONING', 'ACTIVE', 'SUSPENDED', 'ARCHIVED'));
--> statement-breakpoint
CREATE TABLE hospital_lifecycle_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id),
  target_id uuid NOT NULL,
  actor_id uuid REFERENCES platform_accounts(id),
  operator_id uuid REFERENCES platform_identities(id),
  action text NOT NULL,
  previous_state text,
  requested_state text NOT NULL,
  outcome text NOT NULL,
  reason text,
  explanation text,
  request_version integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX hospital_lifecycle_audit_tenant_time_idx ON hospital_lifecycle_audit (tenant_id, created_at, id);
