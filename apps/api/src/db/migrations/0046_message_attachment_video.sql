-- WhatsNexus carries video too (mp4 up to 16 MB); the Inbox can show and send it.
ALTER TYPE "message_attachment_kind" ADD VALUE IF NOT EXISTS 'video';
