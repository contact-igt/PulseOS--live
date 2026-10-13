-- A template message is laid out differently in the Inbox (header media, formatted body, buttons), so say what a message is.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'text';
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "template_name" text;
