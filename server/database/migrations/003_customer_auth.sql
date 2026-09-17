-- Wave 5 — Customer Identity, Auth Sessions, and Addresses.
--
-- IMPORTANT CONTEXT (see docs/MIGRATION.md §18): the shared MySQL instance
-- this project's `npm run migrate` runs against already had every table
-- below EXCEPT `addresses` — created by an earlier, different migration
-- lineage (`schema_migrations` row `001_initial_schema`, not any file in
-- this directory) that populated it with real historical customer/OTP/
-- session data during what was evidently the corcotton-store source
-- project's own development/testing. This file uses `CREATE TABLE IF NOT
-- EXISTS` for exactly that reason: it is a NO-OP against that existing,
-- populated database (nothing is altered, no data is touched), while still
-- making this schema reproducible on a genuinely fresh database (a new
-- dev machine, CI, staging) that doesn't carry that legacy history. The
-- exact column/constraint definitions below were captured verbatim via
-- `SHOW CREATE TABLE` against the live legacy tables — this is a
-- documentation/reproducibility migration, not a redesign.
--
-- Schema authored by (and adapted from) the source `corcotton-store`
-- project's own `src/modules/{auth,customers,otp}` domain — see
-- docs/MIGRATION.md's Wave 5 backend salvage table for the REUSE/ADAPT/
-- REJECT classification of every source file this schema/logic came from.

CREATE TABLE IF NOT EXISTS `customers` (
  `id` char(36) NOT NULL,
  `first_name` varchar(120) DEFAULT NULL,
  `last_name` varchar(120) DEFAULT NULL,
  `status` varchar(32) NOT NULL DEFAULT 'PENDING_PROFILE',
  `profile_completed_at` datetime(3) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  CONSTRAINT `chk_customers_status` CHECK ((`status` in ('PENDING_PROFILE','ACTIVE','SUSPENDED')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `customer_identities` (
  `id` char(36) NOT NULL,
  `customer_id` char(36) NOT NULL,
  `provider` varchar(32) NOT NULL,
  `provider_subject` varchar(255) NOT NULL,
  `verified_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_customer_identities_provider_subject` (`provider`,`provider_subject`),
  KEY `idx_customer_identities_customer_id` (`customer_id`),
  CONSTRAINT `fk_customer_identities_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE,
  CONSTRAINT `chk_customer_identities_provider` CHECK ((`provider` in ('PHONE_OTP','EMAIL_OTP','GOOGLE')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `customer_contacts` (
  `id` char(36) NOT NULL,
  `customer_id` char(36) NOT NULL,
  `contact_type` varchar(16) NOT NULL,
  `value` varchar(255) NOT NULL,
  `normalized_value` varchar(255) NOT NULL,
  `is_verified` tinyint(1) NOT NULL DEFAULT '0',
  `verified_at` datetime(3) DEFAULT NULL,
  `source` varchar(64) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_customer_contacts_customer_type` (`customer_id`,`contact_type`),
  KEY `idx_customer_contacts_type_normalized` (`contact_type`,`normalized_value`),
  CONSTRAINT `fk_customer_contacts_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE,
  CONSTRAINT `chk_customer_contacts_type` CHECK ((`contact_type` in ('EMAIL','PHONE')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `otp_challenges` (
  `id` char(36) NOT NULL,
  `purpose` varchar(32) NOT NULL,
  `channel` varchar(16) NOT NULL,
  `destination_normalized` varchar(255) NOT NULL,
  `otp_hash` varchar(255) NOT NULL,
  `customer_id` char(36) DEFAULT NULL,
  `identity_link_request_id` char(36) DEFAULT NULL,
  `status` varchar(32) NOT NULL DEFAULT 'PENDING',
  `attempt_count` int NOT NULL DEFAULT '0',
  `max_attempts` int NOT NULL DEFAULT '5',
  `expires_at` datetime(3) NOT NULL,
  `consumed_at` datetime(3) DEFAULT NULL,
  `requested_ip` varchar(255) DEFAULT NULL,
  `user_agent` text,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_otp_challenges_destination_time` (`destination_normalized`,`created_at` DESC),
  KEY `idx_otp_challenges_status_expiry` (`status`,`expires_at`),
  KEY `fk_otp_challenges_customer` (`customer_id`),
  CONSTRAINT `fk_otp_challenges_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL,
  CONSTRAINT `chk_otp_challenges_attempt_count` CHECK ((`attempt_count` >= 0)),
  CONSTRAINT `chk_otp_challenges_channel` CHECK ((`channel` in ('WHATSAPP','EMAIL'))),
  CONSTRAINT `chk_otp_challenges_max_attempts` CHECK ((`max_attempts` > 0)),
  CONSTRAINT `chk_otp_challenges_purpose` CHECK ((`purpose` in ('LOGIN','VERIFY_CONTACT','LINK_IDENTITY'))),
  CONSTRAINT `chk_otp_challenges_status` CHECK ((`status` in ('PENDING','CONSUMED','EXPIRED','LOCKED','CANCELLED')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `auth_sessions` (
  `id` char(36) NOT NULL,
  `customer_id` char(36) NOT NULL,
  `token_hash` varchar(255) NOT NULL,
  `status` varchar(32) NOT NULL DEFAULT 'ACTIVE',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expires_at` datetime(3) NOT NULL,
  `last_seen_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `user_agent` text,
  `ip_address` varchar(128) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_auth_sessions_token_hash` (`token_hash`),
  KEY `idx_auth_sessions_customer_id` (`customer_id`),
  KEY `idx_auth_sessions_status_expiry` (`status`,`expires_at`),
  CONSTRAINT `fk_auth_sessions_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE,
  CONSTRAINT `chk_auth_sessions_status` CHECK ((`status` in ('ACTIVE','REVOKED','EXPIRED')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `identity_link_requests` (
  `id` char(36) NOT NULL,
  `candidate_customer_id` char(36) NOT NULL,
  `incoming_provider` varchar(32) NOT NULL,
  `incoming_provider_subject` varchar(255) NOT NULL,
  `incoming_verified_contact` varchar(255) DEFAULT NULL,
  `proof_channel` varchar(16) NOT NULL,
  `status` varchar(32) NOT NULL DEFAULT 'PENDING',
  `expires_at` datetime(3) NOT NULL,
  `completed_at` datetime(3) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_identity_link_requests_status_expiry` (`status`,`expires_at`),
  KEY `fk_identity_link_requests_customer` (`candidate_customer_id`),
  CONSTRAINT `fk_identity_link_requests_customer` FOREIGN KEY (`candidate_customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE,
  CONSTRAINT `chk_identity_link_requests_channel` CHECK ((`proof_channel` in ('WHATSAPP','EMAIL'))),
  CONSTRAINT `chk_identity_link_requests_provider` CHECK ((`incoming_provider` in ('PHONE_OTP','EMAIL_OTP','GOOGLE'))),
  CONSTRAINT `chk_identity_link_requests_status` CHECK ((`status` in ('PENDING','VERIFIED','EXPIRED','CONFLICT','CANCELLED')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `audit_logs` (
  `id` char(36) NOT NULL,
  `customer_id` char(36) DEFAULT NULL,
  `event_type` varchar(120) NOT NULL,
  `event_code` varchar(120) DEFAULT NULL,
  `metadata` json DEFAULT NULL,
  `request_id` varchar(120) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_audit_logs_customer_id` (`customer_id`),
  KEY `idx_audit_logs_event_type_created` (`event_type`,`created_at` DESC),
  CONSTRAINT `fk_audit_logs_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- NEW this wave (CREATE_NEW — no equivalent exists anywhere, legacy or
-- otherwise). One customer address domain shared by Account (Wave 5) and
-- Checkout (Wave 6) — deliberately not two separate AccountAddress/
-- CheckoutAddress models (migration brief §79). India-first validation
-- (10-digit phone, 6-digit PIN) is enforced in application code
-- (server/src/modules/addresses/service.js), not via a CHECK constraint,
-- so the column stays reusable if multi-country shipping is ever added.
CREATE TABLE IF NOT EXISTS `addresses` (
  `id` char(36) NOT NULL,
  `customer_id` char(36) NOT NULL,
  `type` varchar(16) NOT NULL DEFAULT 'SHIPPING',
  `first_name` varchar(120) NOT NULL,
  `last_name` varchar(120) NOT NULL,
  `phone` varchar(20) NOT NULL,
  `address_line1` varchar(255) NOT NULL,
  `address_line2` varchar(255) DEFAULT NULL,
  `city` varchar(120) NOT NULL,
  `state` varchar(120) NOT NULL,
  `postal_code` varchar(12) NOT NULL,
  `country` varchar(2) NOT NULL DEFAULT 'IN',
  `is_default` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_addresses_customer_id` (`customer_id`),
  CONSTRAINT `fk_addresses_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE,
  CONSTRAINT `chk_addresses_type` CHECK ((`type` in ('SHIPPING','BILLING')))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
