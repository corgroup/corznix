-- Wave 8G-3: support / customer-service cases.
--
-- Support REFERENCES the order / return / exchange authorities — it never
-- owns or mutates their lifecycle (§48/§58/§59). A case can link to an order
-- and/or a return request (ON DELETE SET NULL keeps the case if the ref is
-- ever removed). No hard delete of cases or messages (§50).
--
-- CUSTOMER_VISIBLE messages and INTERNAL notes live in one table separated by
-- `visibility` — the customer API only ever selects visibility = 'CUSTOMER'
-- (§52). Assignment carries an optimistic version so two agents can't
-- silently overwrite each other (§55).
--
-- Communication delivery is Wave 8G-7. `support_events` carries the intent
-- seam (TICKET_CREATED / STAFF_REPLIED / TICKET_RESOLVED) with no real send
-- (§60). Attachments and inbound email are deferred (§54/§62).
--
-- Forward-only, non-destructive. MySQL 8.x.

CREATE TABLE support_tickets (
  id CHAR(36) NOT NULL,
  ticket_number VARCHAR(48) NOT NULL,
  customer_id CHAR(36) NOT NULL,
  category VARCHAR(16) NOT NULL DEFAULT 'GENERAL',
  priority VARCHAR(8) NOT NULL DEFAULT 'NORMAL',
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  subject VARCHAR(200) NOT NULL,
  order_id CHAR(36) NULL,
  return_request_id CHAR(36) NULL,
  -- Small frozen context (order number, status at open) — never a mutable
  -- copy of order data (§57).
  context_snapshot_json JSON NULL,
  assigned_staff_id CHAR(36) NULL,
  -- Optimistic concurrency for assignment (§55). Every assignment write must
  -- present the version it read.
  assignment_version INT UNSIGNED NOT NULL DEFAULT 0,
  idempotency_key VARCHAR(160) NULL,
  first_response_at DATETIME(3) NULL,
  resolved_at DATETIME(3) NULL,
  closed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_support_tickets_number (ticket_number),
  UNIQUE KEY uk_support_tickets_idempotency (idempotency_key),
  KEY idx_support_tickets_customer (customer_id, created_at),
  KEY idx_support_tickets_status (status, priority),
  KEY idx_support_tickets_assigned (assigned_staff_id),
  CONSTRAINT fk_support_tickets_customer FOREIGN KEY (customer_id)
    REFERENCES customers(id) ON DELETE RESTRICT,
  CONSTRAINT fk_support_tickets_order FOREIGN KEY (order_id)
    REFERENCES orders(id) ON DELETE SET NULL,
  CONSTRAINT fk_support_tickets_return FOREIGN KEY (return_request_id)
    REFERENCES return_requests(id) ON DELETE SET NULL,
  CONSTRAINT fk_support_tickets_assigned FOREIGN KEY (assigned_staff_id)
    REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT chk_support_tickets_category CHECK (category IN
    ('GENERAL','ORDER','DELIVERY','PAYMENT','RETURN','EXCHANGE','PRODUCT')),
  CONSTRAINT chk_support_tickets_priority CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  CONSTRAINT chk_support_tickets_status CHECK (status IN
    ('OPEN','IN_PROGRESS','WAITING_CUSTOMER','WAITING_INTERNAL','RESOLVED','CLOSED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE support_messages (
  id CHAR(36) NOT NULL,
  ticket_id CHAR(36) NOT NULL,
  author_type VARCHAR(12) NOT NULL,
  author_id CHAR(36) NULL,
  visibility VARCHAR(16) NOT NULL,
  body VARCHAR(5000) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_support_messages_ticket (ticket_id, created_at, id),
  CONSTRAINT fk_support_messages_ticket FOREIGN KEY (ticket_id)
    REFERENCES support_tickets(id) ON DELETE CASCADE,
  CONSTRAINT chk_support_messages_author CHECK (author_type IN ('CUSTOMER','STAFF','SYSTEM')),
  CONSTRAINT chk_support_messages_visibility CHECK (visibility IN ('CUSTOMER','INTERNAL'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE support_events (
  id CHAR(36) NOT NULL,
  ticket_id CHAR(36) NOT NULL,
  event_type VARCHAR(48) NOT NULL,
  from_status VARCHAR(20) NULL,
  to_status VARCHAR(20) NULL,
  actor_type VARCHAR(12) NOT NULL DEFAULT 'SYSTEM',
  actor_id CHAR(36) NULL,
  detail_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_support_events_ticket (ticket_id, created_at),
  CONSTRAINT fk_support_events_ticket FOREIGN KEY (ticket_id)
    REFERENCES support_tickets(id) ON DELETE CASCADE,
  CONSTRAINT chk_support_events_actor CHECK (actor_type IN ('CUSTOMER','STAFF','SYSTEM'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
