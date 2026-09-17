-- Wave 6F: immutable orders and exactly-once Checkout finalization.
CREATE TABLE orders (
  id CHAR(36) NOT NULL, order_number VARCHAR(40) NOT NULL,
  checkout_id CHAR(36) NOT NULL, customer_id CHAR(36) NOT NULL,
  inventory_reservation_id CHAR(36) NOT NULL,
  order_status VARCHAR(20) NOT NULL DEFAULT 'PLACED',
  payment_status VARCHAR(24) NOT NULL,
  fulfillment_status VARCHAR(24) NOT NULL DEFAULT 'UNFULFILLED',
  payment_mode VARCHAR(24) NOT NULL,
  currency CHAR(3) NOT NULL, subtotal_minor INT UNSIGNED NOT NULL,
  shipping_minor INT UNSIGNED NOT NULL, total_minor INT UNSIGNED NOT NULL,
  online_paid_minor INT UNSIGNED NOT NULL, cod_due_minor INT UNSIGNED NOT NULL,
  shipping_address_snapshot JSON NOT NULL, shipping_snapshot JSON NOT NULL,
  finalization_source VARCHAR(32) NOT NULL,
  placed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id), UNIQUE KEY uk_orders_number (order_number),
  UNIQUE KEY uk_orders_checkout (checkout_id), UNIQUE KEY uk_orders_reservation (inventory_reservation_id),
  KEY idx_orders_customer_placed (customer_id,placed_at),
  CONSTRAINT fk_orders_checkout FOREIGN KEY (checkout_id) REFERENCES checkout_sessions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT,
  CONSTRAINT fk_orders_reservation FOREIGN KEY (inventory_reservation_id) REFERENCES inventory_reservations(id) ON DELETE RESTRICT,
  CONSTRAINT chk_order_status CHECK (order_status IN ('PLACED','CANCELLED')),
  CONSTRAINT chk_order_payment_status CHECK (payment_status IN ('PAID','COD_DUE','PARTIALLY_PAID')),
  CONSTRAINT chk_order_fulfillment_status CHECK (fulfillment_status IN ('UNFULFILLED','FULFILLED','CANCELLED')),
  CONSTRAINT chk_order_payment_mode CHECK (payment_mode IN ('PREPAID','FULL_COD','PARTIAL_COD')),
  CONSTRAINT chk_order_totals CHECK (total_minor=subtotal_minor+shipping_minor AND online_paid_minor+cod_due_minor=total_minor)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE order_items (
  id CHAR(36) NOT NULL, order_id CHAR(36) NOT NULL,
  product_id CHAR(36) NOT NULL, variant_id CHAR(36) NOT NULL, sku_id CHAR(36) NOT NULL,
  product_name VARCHAR(200) NOT NULL, sku VARCHAR(64) NOT NULL,
  selected_size VARCHAR(20) NULL, selected_color VARCHAR(60) NULL,
  quantity INT UNSIGNED NOT NULL, unit_price_minor INT UNSIGNED NOT NULL,
  line_total_minor INT UNSIGNED NOT NULL, media_snapshot JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id), KEY idx_order_items_order (order_id),
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT,
  CONSTRAINT fk_order_items_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
  CONSTRAINT fk_order_items_variant FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_order_items_sku FOREIGN KEY (sku_id) REFERENCES skus(id) ON DELETE RESTRICT,
  CONSTRAINT chk_order_item_values CHECK (quantity>0 AND line_total_minor=unit_price_minor*quantity)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE order_finalization_jobs (
  checkout_id CHAR(36) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0, last_error_code VARCHAR(80) NULL,
  next_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  locked_at DATETIME(3) NULL, completed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (checkout_id), KEY idx_order_finalization_jobs_due (status,next_attempt_at),
  CONSTRAINT fk_order_finalization_job_checkout FOREIGN KEY (checkout_id) REFERENCES checkout_sessions(id) ON DELETE CASCADE,
  CONSTRAINT chk_order_finalization_job_status CHECK (status IN ('PENDING','PROCESSING','RETRY','COMPLETED','RECONCILIATION_REQUIRED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE payment_obligations ADD COLUMN order_id CHAR(36) NULL AFTER checkout_id,
  ADD KEY idx_payment_obligations_order (order_id),
  ADD CONSTRAINT fk_payment_obligations_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT;

ALTER TABLE checkout_sessions DROP CHECK chk_checkout_status,
  ADD CONSTRAINT chk_checkout_status CHECK (status IN ('ACTIVE','READY_FOR_PAYMENT','FINALIZED','EXPIRED','CANCELLED')),
  ADD COLUMN finalized_at DATETIME(3) NULL AFTER cancelled_at;
