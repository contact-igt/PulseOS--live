ALTER TABLE "tenants" ADD COLUMN "login_slug" text;--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_login_slug_unique" ON "tenants" USING btree ("login_slug");--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_login_slug_shape" CHECK ("tenants"."login_slug" is null or "tenants"."login_slug" ~ '^[a-z][a-z0-9-]{1,38}[a-z0-9]$');