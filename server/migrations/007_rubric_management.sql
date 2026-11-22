-- =============================================================================
-- 007 Rubric Management: the competition's fixed rubric shape
-- (additive only; no existing data is changed)
--
-- The iSchool × Al Ahly rubric always has 4 sections with 2 criteria each.
-- Every criterion is rated 1 to 5 stars. Each section has a percentage weight;
-- the four weights total exactly 100. Scoring:
--
--   section rating  = (criterion 1 + criterion 2) / 2
--   section score   = section rating / 5 x section weight
--   final score     = sum of the 4 section scores (out of 100)
--
-- This reuses the Phase 1 scoring model unchanged: each criterion's weight is
-- stored as section weight / 10, so  score x weight  summed over a section's two
-- criteria equals the section score above, and the maximum total is 100.
--
-- * rubric_versions gains a description and a revision counter (stops two
--   admins overwriting each other's draft).
-- * rubric_sections gains weight_percent; rubric_criteria gains guidelines.
-- * The database guarantees at most ONE published version and ONE draft.
-- * The version trigger is replaced: the new columns are immutable once
--   published, and publishing checks the fixed shape and the weights.
-- =============================================================================

ALTER TABLE rubric_versions
  ADD COLUMN description TEXT NULL AFTER title,
  ADD COLUMN revision INT UNSIGNED NOT NULL DEFAULT 1 AFTER total_target,
  ADD COLUMN published_slot TINYINT AS (IF(status = 'published', 1, NULL)) PERSISTENT,
  ADD COLUMN draft_slot TINYINT AS (IF(status = 'draft', 1, NULL)) PERSISTENT,
  ADD UNIQUE KEY uq_rv_one_published (published_slot),
  ADD UNIQUE KEY uq_rv_one_draft (draft_slot);

ALTER TABLE rubric_sections
  ADD COLUMN weight_percent TINYINT UNSIGNED NULL AFTER is_bonus,
  ADD CONSTRAINT chk_rs_weight_percent CHECK (weight_percent IS NULL OR weight_percent BETWEEN 1 AND 100);

ALTER TABLE rubric_criteria
  ADD COLUMN guidelines TEXT NULL AFTER description;

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
        AND NEW.total_target <=> OLD.total_target AND NEW.revision <=> OLD.revision
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

    SELECT COUNT(*), COALESCE(SUM(weight_percent), 0) INTO v_sections, v_weight_total
      FROM rubric_sections WHERE rubric_version_id = OLD.id;
    IF v_sections <> 4 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot publish: the rubric must have exactly 4 sections';
    END IF;

    SELECT COUNT(*) INTO v_bad_sections FROM rubric_sections s
      WHERE s.rubric_version_id = OLD.id
        AND (s.is_bonus = TRUE OR s.weight_percent IS NULL
             OR (SELECT COUNT(*) FROM rubric_criteria c WHERE c.section_id = s.id) <> 2);
    IF v_bad_sections > 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot publish: every section needs a weight and exactly 2 criteria';
    END IF;

    IF v_weight_total <> 100 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot publish: the section weights must total exactly 100%';
    END IF;

    -- Every criterion: 1 to 5 stars, required, weight = section weight / 10.
    SELECT COUNT(*) INTO v_bad_criteria
      FROM rubric_criteria c JOIN rubric_sections s ON s.id = c.section_id
      WHERE c.rubric_version_id = OLD.id
        AND (c.min_score <> 1 OR c.max_score <> 5 OR c.is_required = FALSE
             OR ABS(c.weight - s.weight_percent / 10) > 0.0005);
    IF v_bad_criteria > 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot publish: every criterion must be a required 1-5 star rating weighted by its section';
    END IF;
  END IF;
END;
