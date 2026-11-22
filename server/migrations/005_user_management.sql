-- =============================================================================
-- 005 User management safeguards (additive only; no existing data is changed)
--
-- The competition must always keep at least one active administrator. The API
-- checks this inside a locked transaction; these triggers enforce it in the
-- database too, for every account and every client (defence in depth).
-- =============================================================================

CREATE TRIGGER trg_users_keep_last_admin BEFORE UPDATE ON users FOR EACH ROW
BEGIN
  IF OLD.role = 'admin' AND OLD.status = 'active'
     AND NOT (NEW.role = 'admin' AND NEW.status = 'active')
     AND (SELECT COUNT(*) FROM users WHERE role = 'admin' AND status = 'active' AND id <> OLD.id) = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The last active administrator cannot be disabled or demoted';
  END IF;
END;

CREATE TRIGGER trg_users_keep_last_admin_delete BEFORE DELETE ON users FOR EACH ROW
BEGIN
  IF OLD.role = 'admin' AND OLD.status = 'active'
     AND (SELECT COUNT(*) FROM users WHERE role = 'admin' AND status = 'active' AND id <> OLD.id) = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The last active administrator cannot be deleted';
  END IF;
END;
