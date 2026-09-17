-- Communications hub (Phase A + B).
--
-- Phase A — customer queries stay in the Support Ticket domain (migration
-- 041). Two purely additive columns:
--   * support_tickets.warehouse_id — the warehouse a ticket relates to,
--     derived from the linked order's fulfillment on open. NULL = not
--     order-linked or not yet allocated. Never mutates order/fulfillment
--     truth — it is a reference, like order_id / return_request_id.
--   * staff_notifications.staff_id — a notification addressed to ONE staff
--     member (a direct message, an @mention, "a customer replied to the
--     ticket assigned to you"). NULL = broadcast / warehouse-scoped as
--     before. A row with staff_id set is visible ONLY to that staff member,
--     regardless of role.
--
-- Phase B — internal staff-to-staff conversations. A separate lightweight
-- messaging domain that reuses nothing from support_tickets (those are
-- customer-facing and require a customer_id). DIRECT threads are deduped on
-- a canonical sorted-pair key so opening a DM twice reuses the thread.
--
-- Forward-only, non-destructive. MySQL 8.x.

-- ---------------------------------------------------------------------------
-- Phase A
-- ---------------------------------------------------------------------------

ALTER TABLE support_tickets
  ADD COLUMN warehouse_id CHAR(36) NULL AFTER return_request_id,
  ADD KEY idx_support_tickets_warehouse (warehouse_id, status),
  ADD CONSTRAINT fk_support_tickets_warehouse
    FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE SET NULL;

ALTER TABLE staff_notifications
  ADD COLUMN staff_id CHAR(36) NULL AFTER warehouse_id,
  ADD KEY idx_staff_notifications_staff (staff_id, created_at),
  ADD CONSTRAINT fk_staff_notifications_staff
    FOREIGN KEY (staff_id) REFERENCES staff_users(id) ON DELETE CASCADE;

-- Widen the category vocabulary for the Communications hub: SUPPORT (a
-- customer query needs attention), MESSAGE (a colleague messaged you),
-- MENTION (a colleague @-tagged you).
ALTER TABLE staff_notifications
  DROP CHECK chk_staff_notifications_category;
ALTER TABLE staff_notifications
  ADD CONSTRAINT chk_staff_notifications_category
    CHECK (category IN ('ORDER','RETURN','SHIPMENT','INVENTORY','SYSTEM','SUPPORT','MESSAGE','MENTION'));

-- ---------------------------------------------------------------------------
-- Phase B — internal messaging
-- ---------------------------------------------------------------------------

CREATE TABLE internal_conversations (
  id CHAR(36) NOT NULL,
  kind VARCHAR(8) NOT NULL DEFAULT 'DIRECT',
  subject VARCHAR(200) NULL,
  -- Canonical dedupe key for DIRECT threads: the two staff ids sorted and
  -- joined with ':'. NULL for GROUP threads (which can be created freely).
  direct_key VARCHAR(80) NULL,
  created_by CHAR(36) NOT NULL,
  -- Optional soft references so an internal thread can be "about" an order /
  -- warehouse. Never a copy of their data.
  order_id CHAR(36) NULL,
  warehouse_id CHAR(36) NULL,
  last_message_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_internal_conversations_direct (direct_key),
  KEY idx_internal_conversations_last (last_message_at),
  KEY idx_internal_conversations_order (order_id),
  CONSTRAINT fk_internal_conversations_creator FOREIGN KEY (created_by)
    REFERENCES staff_users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_internal_conversations_order FOREIGN KEY (order_id)
    REFERENCES orders(id) ON DELETE SET NULL,
  CONSTRAINT fk_internal_conversations_warehouse FOREIGN KEY (warehouse_id)
    REFERENCES warehouses(id) ON DELETE SET NULL,
  CONSTRAINT chk_internal_conversations_kind CHECK (kind IN ('DIRECT','GROUP'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE internal_conversation_participants (
  conversation_id CHAR(36) NOT NULL,
  staff_id CHAR(36) NOT NULL,
  role VARCHAR(8) NOT NULL DEFAULT 'MEMBER',
  -- Read cursor — the id of the last message this participant has seen.
  last_read_message_id CHAR(36) NULL,
  added_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (conversation_id, staff_id),
  KEY idx_internal_participants_staff (staff_id),
  CONSTRAINT fk_internal_participants_conversation FOREIGN KEY (conversation_id)
    REFERENCES internal_conversations(id) ON DELETE CASCADE,
  CONSTRAINT fk_internal_participants_staff FOREIGN KEY (staff_id)
    REFERENCES staff_users(id) ON DELETE CASCADE,
  CONSTRAINT chk_internal_participants_role CHECK (role IN ('OWNER','MEMBER'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE internal_messages (
  id CHAR(36) NOT NULL,
  conversation_id CHAR(36) NOT NULL,
  sender_staff_id CHAR(36) NOT NULL,
  body VARCHAR(5000) NOT NULL,
  -- Resolved @mention staff ids, JSON array. Drives the Mentions feed.
  mentions_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_internal_messages_conversation (conversation_id, created_at, id),
  CONSTRAINT fk_internal_messages_conversation FOREIGN KEY (conversation_id)
    REFERENCES internal_conversations(id) ON DELETE CASCADE,
  CONSTRAINT fk_internal_messages_sender FOREIGN KEY (sender_staff_id)
    REFERENCES staff_users(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
