CREATE TABLE "tenant_capabilities" (
	"tenant_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_capabilities_tenant_id_capability_pk" PRIMARY KEY("tenant_id","capability")
);
--> statement-breakpoint
ALTER TABLE "tenant_capabilities" ADD CONSTRAINT "tenant_capabilities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;