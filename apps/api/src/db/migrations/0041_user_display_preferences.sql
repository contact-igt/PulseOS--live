ALTER TABLE "users" ADD COLUMN "interface_size" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "text_size" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_interface_size_shape" CHECK ("users"."interface_size" is null or "users"."interface_size" in ('compact', 'comfortable', 'large'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_text_size_shape" CHECK ("users"."text_size" is null or "users"."text_size" in ('small', 'default', 'large', 'xlarge'));