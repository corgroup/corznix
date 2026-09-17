-- The order-total invariant has to know about store credit.
--
-- `chk_order_totals` has said "online_paid + cod_due (+ exchange credit) =
-- total" since 012. Migration 116 let a customer pay with store credit, and an
-- order paid entirely from the balance has online_paid = 0 and cod_due = 0 —
-- so the database refused to write it. On production that surfaced as a plain
-- 500 on Place Order with nothing recorded and the ledger untouched: correct
-- behaviour from the constraint, and a migration that should have come with
-- 116.
--
-- The invariant itself is not weakened. It gains the third way an order can be
-- paid for, so it still adds up to the total, exactly.
--
-- Forward-only, non-destructive. MySQL 8.x.

-- The discount term is carried over deliberately: the live clause is
-- "total = subtotal + shipping - discount", not the 012 wording, and rewriting
-- it from the older migration would have rejected every discounted order that
-- already exists.
ALTER TABLE orders
  DROP CHECK chk_order_totals,
  ADD CONSTRAINT chk_order_totals CHECK (
    total_minor = subtotal_minor + shipping_minor - discount_minor
    AND online_paid_minor + cod_due_minor + exchange_credit_applied_minor + store_credit_applied_minor = total_minor
  );
