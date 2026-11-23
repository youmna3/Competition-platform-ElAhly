-- Format 4: numeric points. Each criterion is scored with a whole number from 0 to
-- its own maximum (stored as min_score = 0, max_score = maximum, weight = 1); a
-- section's points are the sum of its criteria and the sections total 100.
-- Additive only: existing rubric versions keep their format, and no evaluation,
-- score or history row is changed.
ALTER TABLE rubric_versions DROP CONSTRAINT chk_rv_scoring_format,
  ADD CONSTRAINT chk_rv_scoring_format CHECK (scoring_format IN (1,2,3,4));

DROP TRIGGER IF EXISTS trg_rv_before_update;

CREATE TRIGGER trg_rv_before_update BEFORE UPDATE ON rubric_versions FOR EACH ROW
BEGIN
  DECLARE v_sections INT DEFAULT 0;
  DECLARE v_bad_sections INT DEFAULT 0;
  DECLARE v_weight_total INT DEFAULT 0;
  DECLARE v_bad_criteria INT DEFAULT 0;

  IF NEW.version_no <> OLD.version_no THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Rubric version number cannot change';
  END IF;

  IF OLD.status = 'retired' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Retired rubric versions are read-only';
  END IF;

  IF OLD.status = 'published' THEN
    IF NEW.status <> 'retired' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Published rubric versions are read-only';
    END IF;
    IF NOT (NEW.title <=> OLD.title AND NEW.description <=> OLD.description
        AND NEW.instructions <=> OLD.instructions
        AND NEW.scale_min <=> OLD.scale_min AND NEW.scale_max <=> OLD.scale_max
        AND NEW.bonus_policy <=> OLD.bonus_policy AND NEW.bonus_cap <=> OLD.bonus_cap
        AND NEW.scoring_format <=> OLD.scoring_format AND NEW.total_target <=> OLD.total_target AND NEW.revision <=> OLD.revision
        AND NEW.published_at <=> OLD.published_at) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Published rubric versions are read-only';
    END IF;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'retired' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A draft must be published or discarded, not retired';
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'published' THEN
    IF CHAR_LENGTH(TRIM(NEW.title)) = 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot publish: the rubric needs a title';
    END IF;

    SELECT COUNT(*), COALESCE(SUM(IF(is_bonus, 0, weight_percent)), 0) INTO v_sections, v_weight_total
      FROM rubric_sections WHERE rubric_version_id = OLD.id;
    IF (NEW.scoring_format = 1 AND v_sections <> 4) OR v_sections < 1 OR v_sections > 10 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot publish: invalid section count for this scoring format';
    END IF;

    SELECT COUNT(*) INTO v_bad_sections FROM rubric_sections s
      WHERE s.rubric_version_id = OLD.id
        AND ((NEW.scoring_format = 1 AND s.is_bonus = TRUE)
             OR (s.is_bonus = FALSE AND (s.weight_percent IS NULL OR s.max_bonus_points IS NOT NULL))
             OR (s.is_bonus = TRUE AND (s.weight_percent IS NOT NULL OR s.max_bonus_points IS NULL))
             OR (NEW.scoring_format < 3 AND (SELECT COUNT(*) FROM rubric_criteria c WHERE c.section_id=s.id) <> 2)
             OR (NEW.scoring_format = 4 AND (s.is_bonus = TRUE OR s.weight_percent <>
                 (SELECT COALESCE(SUM(pc.max_score), 0) FROM rubric_criteria pc WHERE pc.section_id = s.id)))
             OR (SELECT COUNT(*) FROM rubric_criteria c WHERE c.section_id=s.id) NOT BETWEEN 1 AND 10);
    IF v_bad_sections > 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot publish: every section needs valid Actual/Bonus limits and a valid question count';
    END IF;

    IF v_weight_total <> 100 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot publish: the section weights must total exactly 100%';
    END IF;

    -- Every criterion must match its version scoring format.
    SELECT COUNT(*) INTO v_bad_criteria
      FROM rubric_criteria c JOIN rubric_sections s ON s.id = c.section_id
      WHERE c.rubric_version_id = OLD.id
        AND IF(NEW.scoring_format = 4,
              -- Points: 0 to the criterion maximum (1-100), required, weight 1.
              c.min_score <> 0 OR c.max_score < 1 OR c.max_score > 100 OR c.is_required <> TRUE
                OR ABS(c.weight - 1) > 0.0005,
              -- Stars: 1 to 5, required unless bonus, weight = section points / (5 x questions).
              c.min_score <> 1 OR c.max_score <> 5 OR c.is_required <> (NOT s.is_bonus)
                OR ABS(c.weight - IF(s.is_bonus, s.max_bonus_points, s.weight_percent) / (5 * (SELECT COUNT(*) FROM rubric_criteria qc WHERE qc.section_id=s.id))) > 0.0005);
    IF v_bad_criteria > 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot publish: invalid score range, requirement or section weighting';
    END IF;
  END IF;
END;
