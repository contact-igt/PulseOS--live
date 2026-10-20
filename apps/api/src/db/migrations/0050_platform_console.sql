-- PulseOS Platform Console: the company-side control plane over every tenant.
-- Additive only: every existing tenant stays ACTIVE / PRODUCTION, every existing account stays ACTIVE with its password.

-- Tenant lifecycle. Existing tenants are live hospitals, so they start ACTIVE.
CREATE TYPE "public"."tenant_status" AS ENUM('DRAFT', 'ONBOARDING', 'ACTIVE', 'SUSPENDED', 'ARCHIVED');
--> statement-breakpoint
-- What kind of workspace this is. Never inferred from a tenant's name.
CREATE TYPE "public"."tenant_environment" AS ENUM('PRODUCTION', 'DEMO', 'TEST');
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "status" "tenant_status" DEFAULT 'ACTIVE' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "environment" "tenant_environment" DEFAULT 'PRODUCTION' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "locale" text DEFAULT 'en-IN' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "industry" text;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "country" text;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "primary_admin_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "status_reason" text;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "status_changed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "created_by_platform_user_id" uuid;
--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_primary_admin_user_id_users_id_fk" FOREIGN KEY ("primary_admin_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_locale_shape" CHECK ("tenants"."locale" ~ '^[a-z]{2}(-[A-Z]{2})?$');
--> statement-breakpoint
CREATE INDEX "tenants_status_idx" ON "tenants" USING btree ("status");
--> statement-breakpoint

-- A `users` row is a tenant account: one person's membership of one hospital, with its role and its own credential.
-- INVITED accounts have no password yet; SUSPENDED and REMOVED accounts keep their history but cannot sign in.
CREATE TYPE "public"."user_status" AS ENUM('ACTIVE', 'INVITED', 'SUSPENDED', 'REMOVED');
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status" "user_status" DEFAULT 'ACTIVE' NOT NULL;
--> statement-breakpoint
-- The per-tenant "PulseOS Support" account used only for audited support edits. Never signs in, never listed as staff.
ALTER TABLE "users" ADD COLUMN "is_system" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_sign_in_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_active_has_password" CHECK ("users"."status" <> 'ACTIVE' or "users"."is_system" or "users"."password_hash" is not null);
--> statement-breakpoint
CREATE INDEX "users_email_lower_idx" ON "users" USING btree (lower("email"));
--> statement-breakpoint

-- Where a session was opened from (shown to platform staff so a session can be recognised before it is revoked).
ALTER TABLE "sessions" ADD COLUMN "last_seen_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "user_agent" text;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "ip_address" text;
--> statement-breakpoint

-- Platform staff (Invictus Global Tech). A separate identity space from tenant accounts: no tenant role ever implies one.
CREATE TYPE "public"."platform_role" AS ENUM('PLATFORM_OWNER', 'PLATFORM_ADMIN', 'IMPLEMENTATION_ADMIN', 'SUPPORT_AGENT', 'PLATFORM_AUDITOR');
--> statement-breakpoint
CREATE TYPE "public"."platform_user_status" AS ENUM('ACTIVE', 'INVITED', 'SUSPENDED');
--> statement-breakpoint
CREATE TABLE "platform_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"role" "platform_role" NOT NULL,
	"status" "platform_user_status" DEFAULT 'INVITED' NOT NULL,
	"last_sign_in_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "platform_users_active_has_password" CHECK ("platform_users"."status" <> 'ACTIVE' or "platform_users"."password_hash" is not null),
	CONSTRAINT "platform_users_name_len" CHECK (char_length("platform_users"."name") between 1 and 120)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "platform_users_email_unique" ON "platform_users" USING btree (lower("email"));
--> statement-breakpoint
CREATE TABLE "platform_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone,
	"user_agent" text,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_sessions" ADD CONSTRAINT "platform_sessions_platform_user_id_platform_users_id_fk" FOREIGN KEY ("platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "platform_sessions_user_idx" ON "platform_sessions" USING btree ("platform_user_id");
--> statement-breakpoint

-- Invitations and password resets. Only a SHA-256 of the token is stored; the token itself exists once, in the message sent.
-- Expiry is a time, not a status: a PENDING row past expires_at is expired.
CREATE TYPE "public"."account_token_purpose" AS ENUM('INVITE', 'PASSWORD_RESET');
--> statement-breakpoint
CREATE TYPE "public"."account_token_status" AS ENUM('PENDING', 'ACCEPTED', 'REVOKED');
--> statement-breakpoint
CREATE TABLE "account_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" "account_token_purpose" NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid,
	"platform_user_id" uuid,
	"tenant_id" uuid,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"status" "account_token_status" DEFAULT 'PENDING' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by_platform_user_id" uuid,
	"delivery_status" text DEFAULT 'NOT_DELIVERED' NOT NULL,
	"send_count" integer DEFAULT 1 NOT NULL,
	"last_sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_tokens_one_account" CHECK (("account_tokens"."user_id" is null) <> ("account_tokens"."platform_user_id" is null)),
	CONSTRAINT "account_tokens_delivery_shape" CHECK ("account_tokens"."delivery_status" in ('SENT', 'NOT_DELIVERED'))
);
--> statement-breakpoint
ALTER TABLE "account_tokens" ADD CONSTRAINT "account_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "account_tokens" ADD CONSTRAINT "account_tokens_platform_user_id_platform_users_id_fk" FOREIGN KEY ("platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "account_tokens" ADD CONSTRAINT "account_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "account_tokens_hash_unique" ON "account_tokens" USING btree ("token_hash");
--> statement-breakpoint
-- At most one live token of each purpose per account: a resend replaces it, it never multiplies.
CREATE UNIQUE INDEX "account_tokens_one_pending" ON "account_tokens" USING btree ("purpose", coalesce("user_id", "platform_user_id")) WHERE "account_tokens"."status" = 'PENDING';
--> statement-breakpoint
CREATE INDEX "account_tokens_tenant_idx" ON "account_tokens" USING btree ("tenant_id");
--> statement-breakpoint

-- Support Mode: a platform staff member looking at one hospital, for a stated reason, for a limited time. Read-only unless
-- edits were explicitly enabled (again with a reason and a shorter limit).
CREATE TABLE "support_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform_user_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"write_enabled_at" timestamp with time zone,
	"write_expires_at" timestamp with time zone,
	"write_reason" text,
	CONSTRAINT "support_sessions_reason_len" CHECK (char_length("support_sessions"."reason") between 5 and 500)
);
--> statement-breakpoint
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_platform_user_id_platform_users_id_fk" FOREIGN KEY ("platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "support_sessions_tenant_idx" ON "support_sessions" USING btree ("tenant_id", "started_at");
--> statement-breakpoint

-- Platform audit trail. Append-only: no foreign keys (it must outlive what it describes) and a trigger refuses UPDATE,
-- DELETE and TRUNCATE. Metadata is scrubbed of secret-shaped keys before it is written.
CREATE TABLE "platform_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_platform_user_id" uuid,
	"actor_label" text NOT NULL,
	"action" text NOT NULL,
	"outcome" text DEFAULT 'SUCCESS' NOT NULL,
	"target_type" text,
	"target_id" text,
	"tenant_id" uuid,
	"context" text DEFAULT 'PLATFORM' NOT NULL,
	"support_session_id" uuid,
	"summary" text NOT NULL,
	"reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_address" text,
	"user_agent" text,
	CONSTRAINT "platform_audit_outcome_shape" CHECK ("platform_audit_events"."outcome" in ('SUCCESS', 'DENIED', 'FAILURE')),
	CONSTRAINT "platform_audit_context_shape" CHECK ("platform_audit_events"."context" in ('PLATFORM', 'SUPPORT_MODE', 'SYSTEM'))
);
--> statement-breakpoint
CREATE INDEX "platform_audit_time_idx" ON "platform_audit_events" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "platform_audit_tenant_time_idx" ON "platform_audit_events" USING btree ("tenant_id", "created_at");
--> statement-breakpoint
CREATE INDEX "platform_audit_action_idx" ON "platform_audit_events" USING btree ("action");
--> statement-breakpoint
CREATE FUNCTION "platform_audit_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'platform_audit_events is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "platform_audit_events_no_update" BEFORE UPDATE OR DELETE ON "platform_audit_events" FOR EACH ROW EXECUTE FUNCTION "platform_audit_events_append_only"();
--> statement-breakpoint
CREATE TRIGGER "platform_audit_events_no_truncate" BEFORE TRUNCATE ON "platform_audit_events" FOR EACH STATEMENT EXECUTE FUNCTION "platform_audit_events_append_only"();
--> statement-breakpoint

-- The few genuinely global settings, each read by real behaviour (see domain/platform/platform-settings.service.ts).
CREATE TABLE "platform_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Every existing hospital gets a primary admin: its earliest Super Admin, else its earliest Hospital Admin.
UPDATE "tenants" t SET "primary_admin_user_id" = (
	SELECT u."id" FROM "users" u
	WHERE u."tenant_id" = t."id" AND u."role" IN ('SUPER_ADMIN', 'HOSPITAL_ADMIN')
	ORDER BY (u."role" = 'SUPER_ADMIN') DESC, u."created_at" ASC
	LIMIT 1
);
--> statement-breakpoint
UPDATE "tenants" t SET "industry" = p."industry", "country" = p."country" FROM "tenant_profiles" p WHERE p."tenant_id" = t."id";
