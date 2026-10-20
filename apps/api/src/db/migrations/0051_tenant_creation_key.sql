-- Create Tenant is idempotent: the console sends one key per wizard submission, so a double-click or a retried request
-- returns the tenant the first request made instead of making a second one.
ALTER TABLE "tenants" ADD COLUMN "creation_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_creation_key_unique" ON "tenants" USING btree ("creation_key");
