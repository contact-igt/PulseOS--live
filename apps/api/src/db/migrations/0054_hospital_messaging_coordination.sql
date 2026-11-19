CREATE TABLE hospital_messaging_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  connector_id uuid NOT NULL,
  remote_tenant_id text NOT NULL,
  partner_origin text NOT NULL,
  pairing_revision timestamptz NOT NULL,
  lifecycle_version integer NOT NULL,
  action text NOT NULL CHECK (action IN ('pause', 'resume')),
  actor text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'failed', 'superseded')),
  expected_version integer,
  attempts integer NOT NULL DEFAULT 0,
  due_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  observation jsonb,
  acknowledgement jsonb,
  error text,
  CONSTRAINT hospital_messaging_commands_lifecycle_unique UNIQUE (tenant_id, lifecycle_version, action)
);
--> statement-breakpoint
CREATE INDEX hospital_messaging_commands_due_idx ON hospital_messaging_commands (status, due_at);
