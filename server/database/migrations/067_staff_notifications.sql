-- Staff notification feed — the real backing store for the CMS topbar bell.
--
-- Broadcast model: one row per operational event, visible to every staff
-- member. Per-staff read state lives in staff_notification_reads (a staff x
-- notification join), so "unread count" is per-user without duplicating the
-- event. Rows are written fire-and-forget by domain flows via
-- staffNotificationService.record() alongside the existing customer-facing
-- notificationService.emit() call sites — a write failure never affects the
-- business transaction.
--
-- dedupe_key is UNIQUE: a domain event that fires twice (retry, replay) does
-- not double-post. INSERT IGNORE on that key.

CREATE TABLE staff_notifications (
  id CHAR(36) NOT NULL,
  category VARCHAR(24) NOT NULL,                       -- ORDER | RETURN | SHIPMENT | INVENTORY | SYSTEM
  event_key VARCHAR(60) NOT NULL,                      -- ORDER_PLACED, RETURN_REQUESTED, ...
  severity VARCHAR(12) NOT NULL DEFAULT 'INFO',        -- INFO | WARNING | CRITICAL
  title VARCHAR(200) NOT NULL,
  body VARCHAR(500) NULL,
  link VARCHAR(300) NULL,                              -- CMS route the bell item deep-links to
  entity_type VARCHAR(40) NULL,
  entity_id VARCHAR(64) NULL,
  dedupe_key VARCHAR(200) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_staff_notifications_dedupe (dedupe_key),
  KEY idx_staff_notifications_created (created_at),
  KEY idx_staff_notifications_category (category, created_at),
  CONSTRAINT chk_staff_notifications_severity CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  CONSTRAINT chk_staff_notifications_category CHECK (category IN ('ORDER','RETURN','SHIPMENT','INVENTORY','SYSTEM'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE staff_notification_reads (
  staff_id CHAR(36) NOT NULL,
  notification_id CHAR(36) NOT NULL,
  read_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (staff_id, notification_id),
  KEY idx_snr_staff (staff_id),
  CONSTRAINT fk_snr_notification FOREIGN KEY (notification_id) REFERENCES staff_notifications(id) ON DELETE CASCADE,
  CONSTRAINT fk_snr_staff FOREIGN KEY (staff_id) REFERENCES staff_users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
