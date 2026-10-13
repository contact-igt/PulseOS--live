-- 0044 was edited to add audio after it had already been applied to some databases, so those never got the value. Idempotent.
ALTER TYPE "message_attachment_kind" ADD VALUE IF NOT EXISTS 'audio';
