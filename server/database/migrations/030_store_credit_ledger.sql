-- Wave 8F-1: canonical "CORCOTTON Credit" store-credit ledger.
--
-- This is the single closed-loop store-credit authority for the platform.
-- It did not previously exist (docs/MIGRATION.md §7 = "Not started"); the
-- Wave 8F briefs assume it does. Built here so the Different-Style Exchange
-- remainder (§65) and return refund-to-credit resolution (§95) have one
-- ledger to write to — never a second wallet.
--
-- Model:
--   store_credit_accounts  one row per (customer, currency). `balance_minor`
--                          is a cached projection of the entries below and is
--                          only ever moved by StoreCreditService under a row
--                          lock — the entries are the source of truth.
--   store_credit_entries   append-only signed ledger. `+amount_minor` grants
--                          credit, `-amount_minor` spends it. Every entry
--                          carries an idempotency key so a retried grant /
--                          debit produces exactly one effect.
--
-- Reserved Exchange Credit (§51) is deliberately NOT modelled here — it is a
-- restricted, exchange-bound liability that lives with the exchange domain,
-- not spendable closed-loop balance. Only the cheaper-item remainder crosses
-- over, as one GRANT entry.
--
-- Forward-only, non-destructive. MySQL 8.x. Integer minor units only.

CREATE TABLE store_credit_accounts (
  id CHAR(36) NOT NULL,
  customer_id CHAR(36) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  balance_minor BIGINT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_store_credit_accounts_customer_currency (customer_id, currency),
  CONSTRAINT fk_store_credit_accounts_customer FOREIGN KEY (customer_id)
    REFERENCES customers(id) ON DELETE RESTRICT,
  CONSTRAINT chk_store_credit_accounts_balance CHECK (balance_minor >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE store_credit_entries (
  id CHAR(36) NOT NULL,
  account_id CHAR(36) NOT NULL,
  customer_id CHAR(36) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  -- GRANT: +ve   DEBIT: -ve   EXPIRE: -ve   ADJUST: signed   REVERSAL: signed
  entry_type VARCHAR(16) NOT NULL,
  amount_minor BIGINT NOT NULL,
  balance_after_minor BIGINT NOT NULL,
  -- Where this movement originated. RETURN_RESOLUTION / EXCHANGE_REMAINDER /
  -- MANUAL / REVERSAL — kept loose on purpose (a VARCHAR, not a CHECK) so
  -- later subwaves add sources without a migration.
  source_type VARCHAR(40) NOT NULL,
  source_id VARCHAR(64) NULL,
  reason VARCHAR(255) NULL,
  idempotency_key VARCHAR(160) NOT NULL,
  created_by_staff_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_store_credit_entries_idempotency (idempotency_key),
  KEY idx_store_credit_entries_account (account_id, created_at),
  KEY idx_store_credit_entries_customer (customer_id, created_at),
  KEY idx_store_credit_entries_source (source_type, source_id),
  CONSTRAINT fk_store_credit_entries_account FOREIGN KEY (account_id)
    REFERENCES store_credit_accounts(id) ON DELETE RESTRICT,
  CONSTRAINT fk_store_credit_entries_customer FOREIGN KEY (customer_id)
    REFERENCES customers(id) ON DELETE RESTRICT,
  CONSTRAINT fk_store_credit_entries_staff FOREIGN KEY (created_by_staff_id)
    REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT chk_store_credit_entries_type CHECK (entry_type IN
    ('GRANT','DEBIT','EXPIRE','ADJUST','REVERSAL')),
  CONSTRAINT chk_store_credit_entries_amount CHECK (amount_minor <> 0),
  CONSTRAINT chk_store_credit_entries_balance_after CHECK (balance_after_minor >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
