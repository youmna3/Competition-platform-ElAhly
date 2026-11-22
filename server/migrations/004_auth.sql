-- =============================================================================
-- 004 Authentication support (additive only; no existing data is changed)
--
-- session_epoch: every session records the epoch it was created with. Bumping
-- it (password change, admin password reset, disabling the account) instantly
-- ends all of that user's other sessions on their next request.
-- =============================================================================

ALTER TABLE users
  ADD COLUMN session_epoch INT UNSIGNED NOT NULL DEFAULT 0 AFTER must_change_password;
