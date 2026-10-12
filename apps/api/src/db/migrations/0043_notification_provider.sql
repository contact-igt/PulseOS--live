-- Additive: records which messaging provider a notification was handed to. NULL for every pre-existing row.
-- No data is rewritten and no unique index is added (provider_message_id history may contain non-unique legacy values).
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "provider" text;
