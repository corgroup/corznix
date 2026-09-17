-- 097 — what the customer actually paid with.
--
-- `payment_attempts` records WHICH GATEWAY took the money (provider_code) but
-- never WHICH INSTRUMENT the customer used, so every payment report could only
-- group by CASHFREE / RAZORPAY. There was no way to answer "how much came in
-- over UPI this week" — the field simply did not exist.
--
-- Cashfree returns it on the payments endpoint (`payment_group` = the family:
-- upi / credit_card / debit_card / net_banking / wallet, `payment_method` = the
-- detail beneath it); the adapter read the array and dropped both.
--
-- Nullable on purpose, and it stays NULL for every attempt made before this
-- migration. Those payments are reported as "Not recorded" rather than guessed
-- into a bucket — a monitoring surface that invents its own history is worse
-- than one that admits a gap.
--
-- `payment_group` is the one to aggregate on. `payment_method` keeps the raw
-- provider detail beside it for a specific enquiry, unnormalised on purpose.

ALTER TABLE payment_attempts
  ADD COLUMN payment_group VARCHAR(32) NULL AFTER provider_raw_status,
  ADD COLUMN payment_method VARCHAR(64) NULL AFTER payment_group,
  ADD KEY idx_payment_attempt_group (payment_group, status);
