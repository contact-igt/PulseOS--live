CREATE TABLE hospital_invitation_deliveries (
  onboarding_id uuid PRIMARY KEY REFERENCES hospital_onboardings(id),
  message_id uuid NOT NULL,
  encrypted_token text,
  status text NOT NULL CHECK (status IN ('pending','accepted','failed','expired','superseded')),
  attempts integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz NOT NULL,
  failure text
);
--> statement-breakpoint
CREATE INDEX hospital_invitation_deliveries_due_idx ON hospital_invitation_deliveries (status, next_attempt_at);
