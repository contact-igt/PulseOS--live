-- A message sent from WhatsNexus by one of ITS agents has no PulseOS user: keep the agent's name so the Inbox can show who wrote it.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "sender_name" text;
