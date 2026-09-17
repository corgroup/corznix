-- 101 — attachments on a support message.
--
-- A customer reporting a damaged parcel, a wrong item or a print defect is
-- describing something they can photograph. Until now the only way to send us
-- the photograph was to open an email thread outside the system, which left
-- the evidence somewhere the ticket could not see it.
--
-- The file itself never lives here: bytes go to the private document storage
-- boundary (modules/documents/storage.js), the same place career-application
-- resumes go, and this table holds only the opaque storage key plus what is
-- needed to serve it back and to show it in a list. There is no public URL —
-- reading an attachment goes through a route that checks ticket ownership.
--
-- Attached to the MESSAGE, not the ticket, so a file sent in a later reply is
-- attributed to that reply rather than to the whole conversation.
--
-- Collation matches support_messages/support_tickets (utf8mb4_unicode_ci)
-- rather than the server default: MySQL refuses a foreign key whose column
-- collation differs from the one it references.

CREATE TABLE support_message_attachments (
  id CHAR(36) NOT NULL,
  message_id CHAR(36) NOT NULL,
  ticket_id CHAR(36) NOT NULL,
  -- Opaque logical key ("<year>/<uuid>.<ext>"), never a URL or a path.
  storage_key VARCHAR(160) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  content_type VARCHAR(100) NOT NULL,
  byte_size INT UNSIGNED NOT NULL,
  -- Lets a re-upload of an identical file be recognised, and gives support a
  -- way to confirm the bytes served are the bytes received.
  sha256 CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_support_attachments_message (message_id),
  KEY idx_support_attachments_ticket (ticket_id),
  CONSTRAINT fk_support_attachments_message FOREIGN KEY (message_id) REFERENCES support_messages (id) ON DELETE CASCADE,
  CONSTRAINT fk_support_attachments_ticket FOREIGN KEY (ticket_id) REFERENCES support_tickets (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
