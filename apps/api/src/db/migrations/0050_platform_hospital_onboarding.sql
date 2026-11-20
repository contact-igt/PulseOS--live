ALTER TABLE "tenants" ADD COLUMN "login_enabled" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
CREATE TABLE "platform_identities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "label" text NOT NULL UNIQUE,
  "role" text NOT NULL,
  "credential_hash" text NOT NULL UNIQUE,
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz
);
--> statement-breakpoint
CREATE TABLE "hospital_onboardings" (
  "id" uuid PRIMARY KEY,
  "request_hash" text NOT NULL,
  "tenant_id" uuid UNIQUE REFERENCES "tenants" ("id"),
  "admin_id" uuid UNIQUE REFERENCES "users" ("id"),
  "provisioning_error" text,
  "template_key" text,
  "template_status" text NOT NULL DEFAULT 'none',
  "invitation_hash" text UNIQUE,
  "invitation_expires_at" timestamptz,
  "invitation_redeemed_at" timestamptz
);
--> statement-breakpoint
CREATE TABLE "platform_audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "onboarding_id" uuid NOT NULL REFERENCES "hospital_onboardings" ("id"),
  "actor_id" uuid REFERENCES "platform_identities" ("id"),
  "action" text NOT NULL,
  "reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "platform_audit_log_onboarding_idx" ON "platform_audit_log" ("onboarding_id");
