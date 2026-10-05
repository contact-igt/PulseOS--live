ALTER TABLE "outbound_webhooks" ADD COLUMN "endpoint_path" text;--> statement-breakpoint
ALTER TABLE "outbound_webhooks" ADD COLUMN "http_method" text DEFAULT 'POST' NOT NULL;--> statement-breakpoint
ALTER TABLE "outbound_webhooks" ADD COLUMN "headers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "outbound_webhooks" ADD COLUMN "payload_mapping" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "outbound_webhooks" ADD COLUMN "webhook_category" text DEFAULT 'CUSTOM' NOT NULL;
