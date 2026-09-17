-- 098 — a partial-COD advance the business keeps if the order comes back.
--
-- The whole point of asking for money up front on a COD order is that the
-- customer has something to lose by refusing the parcel. Until now the advance
-- was refunded in full on both paths that return money — cancellation
-- (`cancellationService`: "Prepaid amount is owed to the customer") and returns
-- (`refundService`: an online share proportional to the order total) — so the
-- deterrent did not exist. A customer could pay Rs 499, refuse delivery, and
-- get the Rs 499 back.
--
-- Three columns, because this has to be decided once and then remembered:
--
--   cod_value_rules.advance_non_refundable
--     the POLICY, per order-value band, beside the advance it applies to.
--
--   checkout_payment_eligibility.advance_non_refundable_minor
--     the AMOUNT as evaluated for this checkout — what the customer is shown
--     before they pay.
--
--   orders.non_refundable_advance_minor
--     the same amount SNAPSHOT on the order. Refunds read this and never
--     re-read the policy: a band edited or archived months later must not
--     change what an existing customer is owed.
--
-- All default to 0 / off, so every order placed before this migration is
-- fully refundable exactly as it was, and a band only withholds money once
-- somebody deliberately ticks it.

ALTER TABLE cod_value_rules
  ADD COLUMN advance_non_refundable TINYINT(1) NOT NULL DEFAULT 0 AFTER advance_value;

ALTER TABLE checkout_payment_eligibility
  ADD COLUMN advance_non_refundable_minor INT UNSIGNED NOT NULL DEFAULT 0 AFTER pay_now_minor;

ALTER TABLE orders
  ADD COLUMN non_refundable_advance_minor INT UNSIGNED NOT NULL DEFAULT 0 AFTER online_paid_minor;

-- How much of that advance a given refund actually withheld. An order can be
-- returned a line at a time, and the advance must be kept exactly ONCE across
-- all of them — summing this column is how the next refund knows what is left
-- to withhold, instead of taking Rs 499 off every partial return.
ALTER TABLE refund_attempts
  ADD COLUMN non_refundable_withheld_minor INT UNSIGNED NOT NULL DEFAULT 0 AFTER amount_minor;

