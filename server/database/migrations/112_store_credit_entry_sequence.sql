-- Store credit ledger: a real insertion order.
--
-- The ledger decided an account's LAST entry with ORDER BY created_at, id.
-- id is a random UUID, so two entries written in the same millisecond (a
-- grant and a debit in one resolution) came out in random order: the drift
-- report compared the balance with the wrong "last balance_after" and flagged
-- a correct account as drifted, and a customer's credit history could list
-- them in the wrong order. Found by verify:reporting failing on one CI run and
-- passing on the next with the same code.
--
-- entry_seq is assigned by MySQL at insert time. Every write locks the
-- account row (FOR UPDATE) first, so within an account the sequence follows
-- the order the balance was computed in. Existing rows are numbered by the
-- ALTER; ties on created_at among them were already ambiguous and stay ordered
-- by created_at first. Forward-only. MySQL 8.x.

ALTER TABLE store_credit_entries
  ADD COLUMN entry_seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT AFTER id,
  ADD UNIQUE KEY uk_store_credit_entries_seq (entry_seq);
