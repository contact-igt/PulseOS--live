ALTER TABLE platform_mfa_recoveries
  ADD COLUMN requested_by uuid REFERENCES platform_accounts(id);
