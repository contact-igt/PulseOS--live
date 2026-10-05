ALTER TABLE "custom_field_definitions" ADD COLUMN "read_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD COLUMN "filterable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD COLUMN "carry_forward" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD COLUMN "rules" jsonb DEFAULT '[]'::jsonb NOT NULL;