CREATE TABLE platform_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(btrim(email))),
  role text NOT NULL CHECK (role IN ('PLATFORM_SUPER_ADMIN', 'PLATFORM_OPERATIONS_ADMIN')),
  permissions text[] NOT NULL DEFAULT '{}',
  password_hash text,
  mfa_secret text,
  last_mfa_step integer,
  setup_hash text UNIQUE,
  setup_expires_at timestamptz,
  disabled_at timestamptz
);
--> statement-breakpoint
CREATE TABLE platform_sessions (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES platform_accounts(id),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
--> statement-breakpoint
CREATE INDEX platform_sessions_account_idx ON platform_sessions(account_id);
--> statement-breakpoint
CREATE TABLE platform_enrollments (
  token_hash text PRIMARY KEY,
  account_id uuid NOT NULL UNIQUE REFERENCES platform_accounts(id),
  password_hash text NOT NULL,
  mfa_secret text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE platform_security_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES platform_accounts(id),
  subject_id uuid REFERENCES platform_accounts(id),
  action text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE platform_audit_log ADD COLUMN browser_actor_id uuid REFERENCES platform_accounts(id);
--> statement-breakpoint
CREATE INDEX platform_audit_time_idx ON platform_audit_log(created_at, id);
--> statement-breakpoint
CREATE INDEX platform_security_audit_time_idx ON platform_security_audit(created_at, id);
