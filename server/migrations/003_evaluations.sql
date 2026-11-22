-- =============================================================================
-- 003 Evaluations, pinned to the rubric version they were started on.
--
-- * An evaluation can only start on the currently PUBLISHED rubric version.
-- * Its rubric_version_id never changes. Scores and section notes carry the same
--   version id and composite foreign keys guarantee they belong to it, so later
--   rubric changes can never alter submitted scores or historical results.
-- * Scores must lie inside the criterion's configured range.
-- * A submitted evaluation is locked; only an admin reopen (status back to
--   'draft') unlocks it.
-- * Nothing here is ever deleted: ON DELETE RESTRICT everywhere plus triggers.
-- =============================================================================

CREATE TABLE evaluations (
  id                 INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  team_id            INT UNSIGNED NOT NULL,
  judge_id           INT UNSIGNED NOT NULL,
  rubric_version_id  INT UNSIGNED NOT NULL,
  status             ENUM('draft','submitted') NOT NULL DEFAULT 'draft',
  core_score         DECIMAL(12,3) NOT NULL DEFAULT 0,   -- recomputed by the server on every save
  bonus_score        DECIMAL(12,3) NOT NULL DEFAULT 0,
  total_score        DECIMAL(12,3) NOT NULL DEFAULT 0,
  required_scored    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  required_count     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  overall_notes      TEXT NULL,
  submitted_at       DATETIME NULL,
  reopened_count     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  row_version        INT UNSIGNED NOT NULL DEFAULT 1,    -- optimistic concurrency for autosave
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_evaluations_team_judge (team_id, judge_id),   -- a double submit can never duplicate
  UNIQUE KEY uq_evaluations_id_version (id, rubric_version_id),
  KEY ix_evaluations_judge (judge_id),
  KEY ix_evaluations_team_status (team_id, status),
  KEY ix_evaluations_version (rubric_version_id),
  CONSTRAINT chk_evaluations_submitted CHECK (
    (status = 'draft' AND submitted_at IS NULL)
    OR (status = 'submitted' AND submitted_at IS NOT NULL AND required_scored = required_count)),
  CONSTRAINT chk_evaluations_counts CHECK (required_scored <= required_count),
  CONSTRAINT fk_evaluations_team FOREIGN KEY (team_id) REFERENCES teams (id) ON DELETE RESTRICT,
  CONSTRAINT fk_evaluations_judge FOREIGN KEY (judge_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_evaluations_version FOREIGN KEY (rubric_version_id) REFERENCES rubric_versions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE evaluation_scores (
  evaluation_id      INT UNSIGNED NOT NULL,
  rubric_version_id  INT UNSIGNED NOT NULL,
  criterion_id       INT UNSIGNED NOT NULL,
  score              SMALLINT NULL,                   -- NULL = not scored yet (draft)
  note               VARCHAR(2000) NOT NULL DEFAULT '',
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (evaluation_id, criterion_id),
  KEY ix_es_criterion (criterion_id, rubric_version_id),
  -- Both sides must use the same rubric version: a score can never point at a
  -- criterion from another version.
  CONSTRAINT fk_es_evaluation FOREIGN KEY (evaluation_id, rubric_version_id)
    REFERENCES evaluations (id, rubric_version_id) ON DELETE RESTRICT,
  CONSTRAINT fk_es_criterion FOREIGN KEY (criterion_id, rubric_version_id)
    REFERENCES rubric_criteria (id, rubric_version_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE evaluation_section_notes (
  evaluation_id      INT UNSIGNED NOT NULL,
  rubric_version_id  INT UNSIGNED NOT NULL,
  section_id         INT UNSIGNED NOT NULL,
  note               VARCHAR(4000) NOT NULL DEFAULT '',
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (evaluation_id, section_id),
  KEY ix_esn_section (section_id, rubric_version_id),
  CONSTRAINT fk_esn_evaluation FOREIGN KEY (evaluation_id, rubric_version_id)
    REFERENCES evaluations (id, rubric_version_id) ON DELETE RESTRICT,
  CONSTRAINT fk_esn_section FOREIGN KEY (section_id, rubric_version_id)
    REFERENCES rubric_sections (id, rubric_version_id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- Integrity triggers
-- ----------------------------------------------------------------------------

CREATE TRIGGER trg_eval_before_insert BEFORE INSERT ON evaluations FOR EACH ROW
BEGIN
  IF NOT EXISTS (SELECT 1 FROM rubric WHERE id = 1 AND published_version_id = NEW.rubric_version_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Evaluations must use the currently published rubric';
  END IF;
  IF NEW.status <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Evaluations must start as drafts';
  END IF;
END;

CREATE TRIGGER trg_eval_before_update BEFORE UPDATE ON evaluations FOR EACH ROW
BEGIN
  IF NEW.team_id <> OLD.team_id OR NEW.judge_id <> OLD.judge_id
     OR NEW.rubric_version_id <> OLD.rubric_version_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Evaluation team, judge and rubric version cannot change';
  END IF;
  -- Submitted evaluations are locked. The only allowed change is a reopen
  -- (status back to draft), which also clears submitted_at.
  IF OLD.status = 'submitted' AND NEW.status = 'submitted' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Submitted evaluations are locked; an admin must reopen it first';
  END IF;
END;

CREATE TRIGGER trg_eval_no_delete BEFORE DELETE ON evaluations FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Evaluations are never deleted';

CREATE TRIGGER trg_es_before_insert BEFORE INSERT ON evaluation_scores FOR EACH ROW
BEGIN
  DECLARE v_min SMALLINT;
  DECLARE v_max SMALLINT;
  IF (SELECT status FROM evaluations WHERE id = NEW.evaluation_id) <> 'draft' THEN
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
  IF (SELECT status FROM evaluations WHERE id = OLD.evaluation_id) <> 'draft' THEN
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
  IF (SELECT status FROM evaluations WHERE id = NEW.evaluation_id) <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Submitted evaluations are locked; an admin must reopen it first';
  END IF;
END;

CREATE TRIGGER trg_esn_before_update BEFORE UPDATE ON evaluation_section_notes FOR EACH ROW
BEGIN
  IF NEW.evaluation_id <> OLD.evaluation_id OR NEW.section_id <> OLD.section_id
     OR NEW.rubric_version_id <> OLD.rubric_version_id THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Section note keys cannot change';
  END IF;
  IF (SELECT status FROM evaluations WHERE id = OLD.evaluation_id) <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Submitted evaluations are locked; an admin must reopen it first';
  END IF;
END;

CREATE TRIGGER trg_esn_no_delete BEFORE DELETE ON evaluation_section_notes FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Section notes are never deleted; clear the note instead';
