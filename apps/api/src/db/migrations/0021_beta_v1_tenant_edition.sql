CREATE TYPE "public"."tenant_edition" AS ENUM('BETA_V1_CORE', 'BETA_V2_GROWTH');--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "edition" "tenant_edition" DEFAULT 'BETA_V2_GROWTH' NOT NULL;