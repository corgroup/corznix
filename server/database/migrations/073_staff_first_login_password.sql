-- First-login forced password change.
--
-- A staff account provisioned from the CLI (`npm run staff:create` /
-- `staff:password`) is created with a temporary password and
-- must_change_password = 1. The first login still issues a session, but every
-- privileged /api/v1/admin/* route (except auth/change-password, auth/logout,
-- me) is refused with PASSWORD_CHANGE_REQUIRED until the staff member sets
-- their own password, which clears the flag and rotates every session.
--
-- Forward-only, non-destructive. MySQL 8.x.

ALTER TABLE staff_users
  ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0 AFTER password_hash;

-- Existing accounts keep must_change_password = 0 (they already chose a
-- password). Only newly provisioned accounts get the forced-change flow.
