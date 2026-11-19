CREATE TABLE suspended_meta_leads (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  connector_id uuid NOT NULL REFERENCES connectors(id),
  external_lead_id text NOT NULL,
  reference jsonb,
  held_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  PRIMARY KEY (connector_id, external_lead_id)
);
--> statement-breakpoint
CREATE INDEX suspended_meta_leads_tenant_time_idx ON suspended_meta_leads (tenant_id, held_at);
--> statement-breakpoint
CREATE INDEX suspended_meta_leads_expiry_idx ON suspended_meta_leads (expires_at);
