-- Metadata only: WhatsNexus retains patient file bytes and serves a short-lived signed link.
DO $$ BEGIN
  CREATE TYPE "message_attachment_kind" AS ENUM ('image', 'document', 'audio');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TYPE "message_attachment_kind" ADD VALUE IF NOT EXISTS 'audio';

CREATE TABLE IF NOT EXISTS "message_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "message_id" uuid NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE,
  "kind" "message_attachment_kind" NOT NULL,
  "provider_media_id" text NOT NULL,
  "file_name" text,
  "mime_type" text,
  "size_bytes" integer
);
CREATE INDEX IF NOT EXISTS "message_attachments_message_idx" ON "message_attachments" ("message_id");
CREATE UNIQUE INDEX IF NOT EXISTS "message_attachments_tenant_provider_media_unique" ON "message_attachments" ("tenant_id", "provider_media_id");
