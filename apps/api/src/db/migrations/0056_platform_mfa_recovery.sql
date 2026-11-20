CREATE TABLE platform_mfa_recoveries (
  account_id uuid PRIMARY KEY REFERENCES platform_accounts(id),
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'completed', 'rejected')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  operator_case text
);
