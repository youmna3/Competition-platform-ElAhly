-- =============================================================================
-- 006 Teams and judge assignments (additive only; no existing data is changed)
--
-- * New assignments need an active team and an active account. Existing
--   assignments stay when a team is archived or an account disabled, so the
--   history of who judged what is kept.
-- * Teams are never deleted; they are archived instead. Their assignments and
--   evaluations therefore always survive.
-- =============================================================================

CREATE TRIGGER trg_team_judges_before_insert BEFORE INSERT ON team_judges FOR EACH ROW
BEGIN
  IF (SELECT status FROM teams WHERE id = NEW.team_id) <> 'active' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Archived teams cannot receive new assignments';
  END IF;
  IF (SELECT status FROM users WHERE id = NEW.judge_id) <> 'active' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Disabled accounts cannot receive new assignments';
  END IF;
END;

CREATE TRIGGER trg_team_judges_no_move BEFORE UPDATE ON team_judges FOR EACH ROW
BEGIN
  IF NEW.team_id <> OLD.team_id OR NEW.judge_id <> OLD.judge_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Assignments cannot be moved; remove and add instead';
  END IF;
END;

CREATE TRIGGER trg_teams_no_delete BEFORE DELETE ON teams FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Teams are never deleted; archive the team instead';

-- Faster team search and sorting.
CREATE INDEX ix_teams_name ON teams (name);
CREATE INDEX ix_teams_created ON teams (created_at);
