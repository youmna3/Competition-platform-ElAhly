-- Additive lifecycle and dedicated maintenance reset. Existing competition data is retained.
CREATE TABLE competition (
 id TINYINT UNSIGNED PRIMARY KEY,
 state ENUM('preparation','judging_open','closed') NOT NULL DEFAULT 'preparation',
 locked_rubric_version_id INT UNSIGNED NULL,
 row_version INT UNSIGNED NOT NULL DEFAULT 1,
 instance_id CHAR(36) NOT NULL,
 database_name VARCHAR(64) NOT NULL,
 started_at DATETIME(3) NULL,
 closed_at DATETIME(3) NULL,
 CONSTRAINT fk_competition_rubric FOREIGN KEY (locked_rubric_version_id) REFERENCES rubric_versions(id),
 CONSTRAINT chk_competition_singleton CHECK (id = 1),
 CONSTRAINT chk_competition_lock CHECK (state = 'preparation' OR locked_rubric_version_id IS NOT NULL)
) ENGINE=InnoDB;
INSERT INTO competition(id,instance_id,database_name) VALUES(1,UUID(),DATABASE());
-- Only the migration/maintenance account has access. Never grant these to the application user.
CREATE TABLE maintenance_reset_context (
 connection_id BIGINT UNSIGNED PRIMARY KEY,
 permit_hash CHAR(64) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE maintenance_reset_permits (
 permit_hash CHAR(64) PRIMARY KEY,
 instance_id CHAR(36) NOT NULL,
 actor_id INT UNSIGNED NOT NULL,
 backup_sha256 CHAR(64) NOT NULL,
 expires_at DATETIME(3) NOT NULL
) ENGINE=InnoDB;

DROP TRIGGER trg_ee_no_delete;
CREATE TRIGGER trg_ee_no_delete BEFORE DELETE ON evaluation_events FOR EACH ROW
BEGIN
 IF NOT EXISTS (SELECT 1 FROM maintenance_reset_context WHERE connection_id=CONNECTION_ID()) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Evaluation history is never deleted';
 END IF;
END;

DROP TRIGGER trg_es_no_delete;
CREATE TRIGGER trg_es_no_delete BEFORE DELETE ON evaluation_scores FOR EACH ROW
BEGIN
 IF NOT EXISTS (SELECT 1 FROM maintenance_reset_context WHERE connection_id=CONNECTION_ID()) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Scores are never deleted; clear the score instead';
 END IF;
END;

DROP TRIGGER trg_esn_no_delete;
CREATE TRIGGER trg_esn_no_delete BEFORE DELETE ON evaluation_section_notes FOR EACH ROW
BEGIN
 IF NOT EXISTS (SELECT 1 FROM maintenance_reset_context WHERE connection_id=CONNECTION_ID()) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Section notes are never deleted; clear the note instead';
 END IF;
END;

DROP TRIGGER trg_eval_no_delete;
CREATE TRIGGER trg_eval_no_delete BEFORE DELETE ON evaluations FOR EACH ROW
BEGIN
 IF NOT EXISTS (SELECT 1 FROM maintenance_reset_context WHERE connection_id=CONNECTION_ID()) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Evaluations are never deleted';
 END IF;
END;

DROP TRIGGER trg_teams_no_delete;
CREATE TRIGGER trg_teams_no_delete BEFORE DELETE ON teams FOR EACH ROW
BEGIN
 IF NOT EXISTS (SELECT 1 FROM maintenance_reset_context WHERE connection_id=CONNECTION_ID()) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Teams are never deleted; archive the team instead';
 END IF;
END;

DROP TRIGGER trg_audit_log_no_delete;
CREATE TRIGGER trg_audit_log_no_delete BEFORE DELETE ON audit_log FOR EACH ROW
BEGIN
 IF NOT EXISTS (SELECT 1 FROM maintenance_reset_context WHERE connection_id=CONNECTION_ID()) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only';
 END IF;
END;

DROP TRIGGER trg_rv_before_delete;
CREATE TRIGGER trg_rv_before_delete BEFORE DELETE ON rubric_versions FOR EACH ROW
BEGIN
 IF OLD.status <> 'draft' AND NOT EXISTS (SELECT 1 FROM maintenance_reset_context WHERE connection_id=CONNECTION_ID()) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Only a draft rubric version can be discarded';
 END IF;
END;

DROP TRIGGER trg_rubric_before_update;
CREATE TRIGGER trg_rubric_before_update BEFORE UPDATE ON rubric FOR EACH ROW
BEGIN
 IF NOT (NEW.published_version_id <=> OLD.published_version_id)
    AND (SELECT state FROM competition WHERE id=1) <> 'preparation'
    AND NOT EXISTS (SELECT 1 FROM maintenance_reset_context WHERE connection_id=CONNECTION_ID()) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Competition rubric is locked';
 END IF;
  IF NEW.published_version_id IS NOT NULL
     AND (SELECT status FROM rubric_versions WHERE id = NEW.published_version_id) <> 'published' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The active rubric must point at a published version';
  END IF;
  IF NEW.draft_version_id IS NOT NULL
     AND (SELECT status FROM rubric_versions WHERE id = NEW.draft_version_id) <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The rubric draft must point at a draft version';
  END IF;
  IF OLD.published_version_id IS NOT NULL AND NEW.published_version_id IS NULL AND NOT EXISTS (SELECT 1 FROM maintenance_reset_context WHERE connection_id=CONNECTION_ID()) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A published rubric cannot be unpublished';
  END IF;
END;


-- Called ONLY by the privileged maintenance connection, inside its existing transaction.
-- No DDL, implicit commits, FK disabling, user variables or dynamic SQL.
CREATE PROCEDURE reset_competition(IN p_database VARCHAR(64), IN p_instance CHAR(36), IN p_permit CHAR(64), IN p_actor INT UNSIGNED)
SQL SECURITY DEFINER
BEGIN
 DECLARE v_id INT UNSIGNED;
 DECLARE v_state VARCHAR(20);
 IF NOT (DATABASE() <=> p_database) OR NOT EXISTS (
   SELECT 1 FROM competition WHERE id=1 AND instance_id=p_instance AND database_name=DATABASE()
 ) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Reset database identity mismatch';
 END IF;
 SELECT id INTO v_id FROM users WHERE id=p_actor AND LOWER(email)='youmna54@gmail.com' AND role='admin' AND status='active' FOR UPDATE;
 IF v_id IS NULL OR NOT EXISTS (
   SELECT 1 FROM maintenance_reset_permits WHERE permit_hash=p_permit AND instance_id=p_instance
    AND actor_id=p_actor AND expires_at>NOW(3) AND backup_sha256 REGEXP '^[a-f0-9]{64}$'
 ) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Reset authorization or verified backup missing';
 END IF;
 SELECT state INTO v_state FROM competition WHERE id=1 FOR UPDATE;
 INSERT INTO maintenance_reset_context(connection_id,permit_hash) VALUES(CONNECTION_ID(),p_permit);
 DELETE FROM evaluation_events;
 DELETE FROM evaluation_scores;
 DELETE FROM evaluation_section_notes;
 DELETE FROM evaluations;
 DELETE FROM team_judges;
 DELETE FROM teams;
 UPDATE competition SET state='preparation',locked_rubric_version_id=NULL,started_at=NULL,closed_at=NULL,row_version=row_version+1 WHERE id=1;
 UPDATE rubric SET published_version_id=NULL,draft_version_id=NULL WHERE id=1;
 DELETE FROM rubric_versions;
 DELETE FROM audit_log;
 UPDATE users SET created_by=NULL WHERE id=p_actor;
 DELETE FROM users WHERE id<>p_actor;
 -- Epoch invalidation defeats in-flight requests that might later save an old session.
 UPDATE users SET session_epoch=session_epoch+1 WHERE id=p_actor;
 UPDATE sessions SET expires=0,data=NULL;
 DELETE FROM maintenance_reset_permits;
 DELETE FROM maintenance_reset_context WHERE connection_id=CONNECTION_ID();
END;
