-- Competition reset keeps exactly three named accounts (credentials, roles and status unchanged)
-- instead of only the requesting administrator. Execution is still restricted to the single
-- reset administrator, with the same permit, identity and backup checks as migration 013.
-- The list below must match RESET_PRESERVED_EMAILS in shared/src/competition.ts.
DROP PROCEDURE reset_competition;

-- Called ONLY by the privileged maintenance connection, inside its existing transaction.
-- No DDL, implicit commits, FK disabling, user variables or dynamic SQL.
CREATE PROCEDURE reset_competition(IN p_database VARCHAR(64), IN p_instance CHAR(36), IN p_permit CHAR(64), IN p_actor INT UNSIGNED)
SQL SECURITY DEFINER
BEGIN
 DECLARE v_id INT UNSIGNED;
 DECLARE v_state VARCHAR(20);
 DECLARE v_p1 INT UNSIGNED;
 DECLARE v_p2 INT UNSIGNED;
 DECLARE v_p3 INT UNSIGNED;
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
 -- All three preserved accounts must exist; otherwise nothing is deleted.
 SELECT id INTO v_p1 FROM users WHERE LOWER(email)='youmna54@gmail.com' FOR UPDATE;
 SELECT id INTO v_p2 FROM users WHERE LOWER(email)='nada.hussien@ischooltech.com' FOR UPDATE;
 SELECT id INTO v_p3 FROM users WHERE LOWER(email)='abdelrhman.elagan@ischooltech.com' FOR UPDATE;
 IF v_p1 IS NULL OR v_p2 IS NULL OR v_p3 IS NULL THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='A preserved account is missing; reset refused';
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
 -- Detach "created by" links that point at accounts about to be deleted.
 UPDATE users SET created_by=NULL WHERE id IN (v_p1,v_p2,v_p3) AND created_by IS NOT NULL AND created_by NOT IN (v_p1,v_p2,v_p3);
 UPDATE users SET created_by=NULL WHERE id NOT IN (v_p1,v_p2,v_p3) AND created_by IS NOT NULL;
 DELETE FROM users WHERE id NOT IN (v_p1,v_p2,v_p3);
 -- Epoch invalidation defeats in-flight requests that might later save an old session.
 UPDATE users SET session_epoch=session_epoch+1 WHERE id IN (v_p1,v_p2,v_p3);
 UPDATE sessions SET expires=0,data=NULL;
 DELETE FROM maintenance_reset_permits;
 DELETE FROM maintenance_reset_context WHERE connection_id=CONNECTION_ID();
END;
