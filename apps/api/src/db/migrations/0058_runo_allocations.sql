CREATE TABLE "runo_allocations" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "external_id" text NOT NULL,
  "process_name" text NOT NULL,
  "customer_name" text,
  "phone" text,
  "status" text,
  "assignee" text,
  "source" text,
  "branch" text,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("tenant_id", "external_id")
);
--> statement-breakpoint
CREATE INDEX "runo_allocations_tenant_created_idx" ON "runo_allocations" ("tenant_id", "created_at", "external_id");
