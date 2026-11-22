-- Administrative corrections preserve submitted status and append immutable before/after history.
-- No existing evaluation or history rows are changed by this migration.
ALTER TABLE evaluation_events
  MODIFY COLUMN event ENUM('started','draft_saved','submitted','reopened','resubmitted','admin_corrected') NOT NULL,
  ADD COLUMN previous_snapshot LONGTEXT NULL,
  ADD CONSTRAINT chk_ee_previous_snapshot CHECK (previous_snapshot IS NULL OR JSON_VALID(previous_snapshot));

DROP TRIGGER IF EXISTS trg_eval_before_update;
DROP TRIGGER IF EXISTS trg_eval_no_delete;
DROP TRIGGER IF EXISTS trg_es_before_insert;
DROP TRIGGER IF EXISTS trg_es_before_update;
DROP TRIGGER IF EXISTS trg_es_no_delete;
DROP TRIGGER IF EXISTS trg_esn_before_insert;
DROP TRIGGER IF EXISTS trg_esn_before_update;

CREATE TRIGGER trg_eval_before_update BEFORE UPDATE ON evaluations FOR EACH ROW
BEGIN
  IF NEW.team_id <> OLD.team_id OR NEW.judge_id <> OLD.judge_id
     OR NEW.rubric_version_id <> OLD.rubric_version_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Evaluation team, judge and rubric version cannot change';
  END IF;
  -- Submitted evaluations are locked. The only allowed change is a reopen
  -- (status back to draft), which also clears submitted_at.
  IF OLD.status = 'submitted' AND NEW.status = 'submitted' AND NOT EXISTS (SELECT 1 FROM evaluation_events ev JOIN users u ON u.id = ev.actor_id WHERE ev.id = @admin_correction_event AND ev.event = 'admin_corrected' AND ev.evaluation_id = OLD.id AND ev.row_version = OLD.row_version + 1 AND u.role = 'admin' AND u.status = 'active') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Submitted evaluations are locked; an admin must reopen it first';
  END IF;
END;

CREATE TRIGGER trg_eval_no_delete BEFORE DELETE ON evaluations FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Evaluations are never deleted';

CREATE TRIGGER trg_es_before_insert BEFORE INSERT ON evaluation_scores FOR EACH ROW
BEGIN
  DECLARE v_min SMALLINT;
  DECLARE v_max SMALLINT;
  IF (SELECT status FROM evaluations WHERE id = NEW.evaluation_id) <> 'draft' AND NOT EXISTS (SELECT 1 FROM evaluation_events ev JOIN evaluations e ON e.id = ev.evaluation_id JOIN users u ON u.id = ev.actor_id WHERE ev.id = @admin_correction_event AND ev.event = 'admin_corrected' AND e.id = NEW.evaluation_id AND ev.row_version = e.row_version + 1 AND u.role = 'admin' AND u.status = 'active') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Submitted evaluations are locked; an admin must reopen it first';
  END IF;
  SELECT min_score, max_score INTO v_min, v_max FROM rubric_criteria WHERE id = NEW.criterion_id;
  IF NEW.score IS NOT NULL AND (NEW.score < v_min OR NEW.score > v_max) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Score is outside the range configured for this criterion';
  END IF;
END;

CREATE TRIGGER trg_es_before_update BEFORE UPDATE ON evaluation_scores FOR EACH ROW
BEGIN
  DECLARE v_min SMALLINT;
  DECLARE v_max SMALLINT;
  IF NEW.evaluation_id <> OLD.evaluation_id OR NEW.criterion_id <> OLD.criterion_id
     OR NEW.rubric_version_id <> OLD.rubric_version_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Score keys cannot change';
  END IF;
  IF (SELECT status FROM evaluations WHERE id = OLD.evaluation_id) <> 'draft' AND NOT EXISTS (SELECT 1 FROM evaluation_events ev JOIN evaluations e ON e.id = ev.evaluation_id JOIN users u ON u.id = ev.actor_id WHERE ev.id = @admin_correction_event AND ev.event = 'admin_corrected' AND e.id = NEW.evaluation_id AND ev.row_version = e.row_version + 1 AND u.role = 'admin' AND u.status = 'active') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Submitted evaluations are locked; an admin must reopen it first';
  END IF;
  SELECT min_score, max_score INTO v_min, v_max FROM rubric_criteria WHERE id = NEW.criterion_id;
  IF NEW.score IS NOT NULL AND (NEW.score < v_min OR NEW.score > v_max) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Score is outside the range configured for this criterion';
  END IF;
END;

CREATE TRIGGER trg_es_no_delete BEFORE DELETE ON evaluation_scores FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Scores are never deleted; clear the score instead';

CREATE TRIGGER trg_esn_before_insert BEFORE INSERT ON evaluation_section_notes FOR EACH ROW
BEGIN
  IF (SELECT status FROM evaluations WHERE id = NEW.evaluation_id) <> 'draft' AND NOT EXISTS (SELECT 1 FROM evaluation_events ev JOIN evaluations e ON e.id = ev.evaluation_id JOIN users u ON u.id = ev.actor_id WHERE ev.id = @admin_correction_event AND ev.event = 'admin_corrected' AND e.id = NEW.evaluation_id AND ev.row_version = e.row_version + 1 AND u.role = 'admin' AND u.status = 'active') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Submitted evaluations are locked; an admin must reopen it first';
  END IF;
END;

CREATE TRIGGER trg_esn_before_update BEFORE UPDATE ON evaluation_section_notes FOR EACH ROW
BEGIN
  IF NEW.evaluation_id <> OLD.evaluation_id OR NEW.section_id <> OLD.section_id
     OR NEW.rubric_version_id <> OLD.rubric_version_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Section note keys cannot change';
  END IF;
  IF (SELECT status FROM evaluations WHERE id = OLD.evaluation_id) <> 'draft' AND NOT EXISTS (SELECT 1 FROM evaluation_events ev JOIN evaluations e ON e.id = ev.evaluation_id JOIN users u ON u.id = ev.actor_id WHERE ev.id = @admin_correction_event AND ev.event = 'admin_corrected' AND e.id = NEW.evaluation_id AND ev.row_version = e.row_version + 1 AND u.role = 'admin' AND u.status = 'active') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Submitted evaluations are locked; an admin must reopen it first';
  END IF;
END;

