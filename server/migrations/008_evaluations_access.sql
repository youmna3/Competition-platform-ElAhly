-- =============================================================================
-- 008 Judge evaluations: who may start one (additive; no existing data changes)
--
-- On top of the 003 rules (published rubric only, starts as a draft), a new
-- evaluation now also needs an active team and an active judge account.
-- Existing evaluations are untouched: archiving a team or disabling an account
-- never removes or changes evaluations that already exist.
-- =============================================================================

DROP TRIGGER IF EXISTS trg_eval_before_insert;

CREATE TRIGGER trg_eval_before_insert BEFORE INSERT ON evaluations FOR EACH ROW
BEGIN
  IF NOT EXISTS (SELECT 1 FROM rubric WHERE id = 1 AND published_version_id = NEW.rubric_version_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Evaluations must use the currently published rubric';
  END IF;
  IF NEW.status <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Evaluations must start as drafts';
  END IF;
  IF (SELECT status FROM teams WHERE id = NEW.team_id) <> 'active' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Archived teams cannot receive new evaluations';
  END IF;
  IF (SELECT status FROM users WHERE id = NEW.judge_id) <> 'active' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Disabled accounts cannot evaluate';
  END IF;
END;
