CREATE TABLE "tenant_login_configs" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"short_name" text,
	"logo_path" text,
	"headline" text,
	"tagline" text,
	"badge_label" text,
	"support_text" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_login_configs_short_name_len" CHECK ("tenant_login_configs"."short_name" is null or char_length("tenant_login_configs"."short_name") between 1 and 40),
	CONSTRAINT "tenant_login_configs_logo_path_shape" CHECK ("tenant_login_configs"."logo_path" is null or "tenant_login_configs"."logo_path" ~ '^/brand/[a-z0-9][a-z0-9._-]{0,80}\.(svg|png|webp)$'),
	CONSTRAINT "tenant_login_configs_headline_len" CHECK ("tenant_login_configs"."headline" is null or char_length("tenant_login_configs"."headline") between 1 and 120),
	CONSTRAINT "tenant_login_configs_tagline_len" CHECK ("tenant_login_configs"."tagline" is null or char_length("tenant_login_configs"."tagline") between 1 and 160),
	CONSTRAINT "tenant_login_configs_badge_len" CHECK ("tenant_login_configs"."badge_label" is null or char_length("tenant_login_configs"."badge_label") between 1 and 24),
	CONSTRAINT "tenant_login_configs_support_len" CHECK ("tenant_login_configs"."support_text" is null or char_length("tenant_login_configs"."support_text") between 1 and 160)
);
--> statement-breakpoint
ALTER TABLE "tenant_login_configs" ADD CONSTRAINT "tenant_login_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;