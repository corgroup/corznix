-- Spending store credit, not only earning it.
--
-- The ledger has existed since 030 and refunds, exchanges and now cancellations
-- all grant credit — but nothing could ever spend it: checkout had no notion of
-- it, so a customer's balance could only grow. A cancelled order's refund "to
-- store credit" was, in practice, money they could not use.
--
-- The amount a customer chooses to put towards a checkout lives on the checkout
-- (it is part of the payment plan, and must survive a page reload), and the
-- amount actually spent is frozen on the order when it is placed — that is what
-- the ledger debit, a later cancellation, and reporting all read.
--
-- Forward-only, non-destructive. MySQL 8.x.

ALTER TABLE checkout_sessions
  ADD COLUMN store_credit_applied_minor INT UNSIGNED NOT NULL DEFAULT 0 AFTER discount_minor;

ALTER TABLE orders
  ADD COLUMN store_credit_applied_minor INT UNSIGNED NOT NULL DEFAULT 0 AFTER discount_minor;
