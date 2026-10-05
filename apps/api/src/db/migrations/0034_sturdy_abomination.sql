CREATE TABLE "tenant_profiles" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"source" text DEFAULT 'signup' NOT NULL,
	"dev_visible" boolean DEFAULT false NOT NULL,
	"owner_name" text NOT NULL,
	"owner_email" text NOT NULL,
	"owner_phone" text NOT NULL,
	"industry" text NOT NULL,
	"organization_type" text,
	"department" text,
	"address_line" text NOT NULL,
	"locality" text,
	"city" text NOT NULL,
	"state" text NOT NULL,
	"pin_code" text NOT NULL,
	"country" text DEFAULT 'India' NOT NULL,
	"discovery_source" text NOT NULL,
	"discovery_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_profiles" ADD CONSTRAINT "tenant_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;