-- Additive versioned scoring. Existing versions keep format 1; no evaluation is updated.
ALTER TABLE rubric_versions
  ADD COLUMN scoring_format TINYINT UNSIGNED NOT NULL DEFAULT 1,
  ADD CONSTRAINT chk_rv_scoring_format CHECK (scoring_format IN (1, 2));
ALTER TABLE rubric_sections
  ADD COLUMN max_bonus_points SMALLINT UNSIGNED NULL,
  ADD CONSTRAINT chk_rs_bonus_points CHECK (max_bonus_points IS NULL OR max_bonus_points BETWEEN 1 AND 100);

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
             OR (SELECT COUNT(*) FROM rubric_criteria c WHERE c.section_id = s.id) <> 2);
    IF v_bad_sections > 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot publish: every section needs valid Actual/Bonus limits and exactly 2 criteria';
    END IF;

    IF v_weight_total <> 100 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot publish: the section weights must total exactly 100%';
    END IF;

    -- Every criterion: 1 to 5 stars, required, weight = section weight / 10.
    SELECT COUNT(*) INTO v_bad_criteria
      FROM rubric_criteria c JOIN rubric_sections s ON s.id = c.section_id
      WHERE c.rubric_version_id = OLD.id
        AND (c.min_score <> 1 OR c.max_score <> 5 OR c.is_required <> (NOT s.is_bonus)
             OR ABS(c.weight - IF(s.is_bonus, s.max_bonus_points, s.weight_percent) / 10) > 0.0005);
    IF v_bad_criteria > 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot publish: invalid star scale, requirement or section weighting';
    END IF;
  END IF;
END;
