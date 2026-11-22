-- =============================================================================
-- 002 Configurable rubric with simple internal versioning
--
-- * `rubric` is a single row (id = 1) pointing at the PUBLISHED version judges
--   use and at most one DRAFT version the admin is editing.
-- * Both pointers start NULL: the rubric is "Not configured". No criteria are
--   seeded; every section and criterion is created by an admin in the UI.
-- * A version is 'draft' (editable), 'published' (active, read-only) or
--   'retired' (replaced by a newer published version, read-only).
-- * Published and retired versions are immutable, enforced by triggers, so
--   evaluations pinned to them can never change retroactively.
--
-- Scoring model (all values come from the admin's configuration):
--   criterion points     = score x weight, score is a whole number in [min_score, max_score]
--   criterion max points = max_score x weight
--   core total           = sum over criteria in non-bonus sections
--   bonus total          = sum over criteria in bonus sections, capped at bonus_cap if set
--   final total          = core + bonus when bonus_policy = 'add_to_total', otherwise core
--                          (bonus then reported separately)
-- =============================================================================

CREATE TABLE rubric_versions (
  id                   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  version_no           INT UNSIGNED NOT NULL,
  status               ENUM('draft','published','retired') NOT NULL DEFAULT 'draft',
  title                VARCHAR(200) NOT NULL DEFAULT '',
  instructions         TEXT NULL,                       -- judging instructions shown to judges
  scale_min            SMALLINT NULL,                   -- optional default scale for new criteria
  scale_max            SMALLINT NULL,
  bonus_policy         ENUM('separate','add_to_total') NOT NULL DEFAULT 'separate',
  bonus_cap            DECIMAL(9,2) NULL,               -- optional maximum bonus points
  total_target         DECIMAL(9,2) NULL,               -- optional: core maximum must equal this to publish
  based_on_version_id  INT UNSIGNED NULL,
  created_by           INT UNSIGNED NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by           INT UNSIGNED NULL,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  published_by         INT UNSIGNED NULL,
  published_at         DATETIME NULL,
  retired_at           DATETIME NULL,
  UNIQUE KEY uq_rubric_versions_no (version_no),
  CONSTRAINT chk_rv_scale CHECK (scale_min IS NULL OR scale_max IS NULL OR scale_min < scale_max),
  CONSTRAINT chk_rv_scale_pair CHECK ((scale_min IS NULL) = (scale_max IS NULL)),
  CONSTRAINT chk_rv_scale_range CHECK (scale_min IS NULL OR (scale_min >= 0 AND scale_max <= 1000)),
  CONSTRAINT chk_rv_bonus_cap CHECK (bonus_cap IS NULL OR bonus_cap > 0),
  CONSTRAINT chk_rv_total_target CHECK (total_target IS NULL OR total_target > 0),
  CONSTRAINT chk_rv_published CHECK (status = 'draft' OR published_at IS NOT NULL),
  CONSTRAINT chk_rv_retired CHECK ((status = 'retired') = (retired_at IS NOT NULL)),
  CONSTRAINT fk_rv_based_on FOREIGN KEY (based_on_version_id) REFERENCES rubric_versions (id) ON DELETE SET NULL,
  CONSTRAINT fk_rv_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_rv_updated_by FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_rv_published_by FOREIGN KEY (published_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Optional labels for the default scale (e.g. 1 = "Weak"). Entered by the admin.
CREATE TABLE rubric_scale_levels (
  rubric_version_id  INT UNSIGNED NOT NULL,
  value              SMALLINT NOT NULL,
  label              VARCHAR(60) NOT NULL,
  description        VARCHAR(500) NOT NULL DEFAULT '',
  PRIMARY KEY (rubric_version_id, value),
  CONSTRAINT chk_rsl_label CHECK (CHAR_LENGTH(TRIM(label)) > 0),
  CONSTRAINT fk_rsl_version FOREIGN KEY (rubric_version_id) REFERENCES rubric_versions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE rubric_sections (
  id                 INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  rubric_version_id  INT UNSIGNED NOT NULL,
  position           SMALLINT UNSIGNED NOT NULL,
  title              VARCHAR(200) NOT NULL,
  description        TEXT NULL,
  is_bonus           BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE KEY uq_rs_position (rubric_version_id, position),
  UNIQUE KEY uq_rs_id_version (id, rubric_version_id),
  CONSTRAINT chk_rs_title CHECK (CHAR_LENGTH(TRIM(title)) > 0),
  CONSTRAINT fk_rs_version FOREIGN KEY (rubric_version_id) REFERENCES rubric_versions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE rubric_criteria (
  id                 INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  rubric_version_id  INT UNSIGNED NOT NULL,
  section_id         INT UNSIGNED NOT NULL,
  position           SMALLINT UNSIGNED NOT NULL,
  title              VARCHAR(300) NOT NULL,
  description        TEXT NULL,                         -- what the judge should look for
  min_score          SMALLINT NOT NULL,
  max_score          SMALLINT NOT NULL,
  weight             DECIMAL(7,3) NOT NULL DEFAULT 1.000,
  is_required        BOOLEAN NOT NULL DEFAULT TRUE,     -- must be scored before submitting
  UNIQUE KEY uq_rc_position (section_id, position),
  UNIQUE KEY uq_rc_id_version (id, rubric_version_id),
  KEY ix_rc_version (rubric_version_id),
  CONSTRAINT chk_rc_title CHECK (CHAR_LENGTH(TRIM(title)) > 0),
  CONSTRAINT chk_rc_range CHECK (min_score >= 0 AND max_score <= 1000 AND min_score < max_score),
  CONSTRAINT chk_rc_weight CHECK (weight > 0 AND weight <= 100),
  -- The criterion's section must belong to the same rubric version.
  CONSTRAINT fk_rc_section FOREIGN KEY (section_id, rubric_version_id)
    REFERENCES rubric_sections (id, rubric_version_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Exactly one rubric for the competition.
CREATE TABLE rubric (
  id                    TINYINT UNSIGNED NOT NULL PRIMARY KEY DEFAULT 1,
  published_version_id  INT UNSIGNED NULL,
  draft_version_id      INT UNSIGNED NULL,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT chk_rubric_single CHECK (id = 1),
  CONSTRAINT fk_rubric_published FOREIGN KEY (published_version_id) REFERENCES rubric_versions (id) ON DELETE RESTRICT,
  CONSTRAINT fk_rubric_draft FOREIGN KEY (draft_version_id) REFERENCES rubric_versions (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Initial state: Not configured (no published version, no draft, no criteria).
INSERT INTO rubric (id, published_version_id, draft_version_id) VALUES (1, NULL, NULL);

-- Read-only summary used by the API and UI.
CREATE VIEW v_rubric_status AS
SELECT
  r.published_version_id,
  r.draft_version_id,
  CASE
    WHEN r.published_version_id IS NULL AND r.draft_version_id IS NULL THEN 'not_configured'
    WHEN r.published_version_id IS NULL THEN 'draft_only'
    WHEN r.draft_version_id IS NULL THEN 'published'
    ELSE 'published_with_draft'
  END AS state,
  pv.version_no AS published_version_no,
  pv.published_at,
  dv.version_no AS draft_version_no
FROM rubric r
LEFT JOIN rubric_versions pv ON pv.id = r.published_version_id
LEFT JOIN rubric_versions dv ON dv.id = r.draft_version_id;

-- ----------------------------------------------------------------------------
-- Integrity triggers
-- ----------------------------------------------------------------------------

-- Version lifecycle: draft -> published -> retired. Content of published and
-- retired versions can never change. Publishing validates the scoring rules.
CREATE TRIGGER trg_rv_before_update BEFORE UPDATE ON rubric_versions FOR EACH ROW
BEGIN
  DECLARE v_core_sections INT DEFAULT 0;
  DECLARE v_empty_sections INT DEFAULT 0;
  DECLARE v_core_criteria INT DEFAULT 0;
  DECLARE v_core_max DECIMAL(12,3) DEFAULT 0;

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
    IF NOT (NEW.title <=> OLD.title AND NEW.instructions <=> OLD.instructions
        AND NEW.scale_min <=> OLD.scale_min AND NEW.scale_max <=> OLD.scale_max
        AND NEW.bonus_policy <=> OLD.bonus_policy AND NEW.bonus_cap <=> OLD.bonus_cap
        AND NEW.total_target <=> OLD.total_target AND NEW.published_at <=> OLD.published_at) THEN
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
    SELECT COUNT(*) INTO v_core_sections FROM rubric_sections
      WHERE rubric_version_id = OLD.id AND is_bonus = FALSE;
    IF v_core_sections = 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot publish: add at least one scored (non-bonus) section';
    END IF;
    SELECT COUNT(*) INTO v_empty_sections FROM rubric_sections s
      WHERE s.rubric_version_id = OLD.id
        AND NOT EXISTS (SELECT 1 FROM rubric_criteria c WHERE c.section_id = s.id);
    IF v_empty_sections > 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot publish: every section needs at least one criterion';
    END IF;
    SELECT COUNT(*), COALESCE(SUM(c.max_score * c.weight), 0) INTO v_core_criteria, v_core_max
      FROM rubric_criteria c JOIN rubric_sections s ON s.id = c.section_id
      WHERE c.rubric_version_id = OLD.id AND s.is_bonus = FALSE;
    IF v_core_criteria = 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot publish: add at least one scored criterion';
    END IF;
    IF NEW.total_target IS NOT NULL AND ABS(v_core_max - NEW.total_target) > 0.001 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot publish: maximum points do not add up to the configured total';
    END IF;
  END IF;
END;

CREATE TRIGGER trg_rv_before_delete BEFORE DELETE ON rubric_versions FOR EACH ROW
BEGIN
  IF OLD.status <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Only a draft rubric version can be discarded';
  END IF;
END;

CREATE TRIGGER trg_rv_before_insert BEFORE INSERT ON rubric_versions FOR EACH ROW
BEGIN
  IF NEW.status <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'New rubric versions must start as drafts';
  END IF;
END;

-- Sections, criteria and scale labels can only change while their version is a draft.
CREATE TRIGGER trg_rs_before_insert BEFORE INSERT ON rubric_sections FOR EACH ROW
BEGIN
  IF (SELECT status FROM rubric_versions WHERE id = NEW.rubric_version_id) <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Rubric is read-only: edit the draft instead';
  END IF;
END;

CREATE TRIGGER trg_rs_before_update BEFORE UPDATE ON rubric_sections FOR EACH ROW
BEGIN
  IF NEW.rubric_version_id <> OLD.rubric_version_id
     OR (SELECT status FROM rubric_versions WHERE id = OLD.rubric_version_id) <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Rubric is read-only: edit the draft instead';
  END IF;
END;

CREATE TRIGGER trg_rs_before_delete BEFORE DELETE ON rubric_sections FOR EACH ROW
BEGIN
  IF (SELECT status FROM rubric_versions WHERE id = OLD.rubric_version_id) <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Rubric is read-only: edit the draft instead';
  END IF;
END;

CREATE TRIGGER trg_rc_before_insert BEFORE INSERT ON rubric_criteria FOR EACH ROW
BEGIN
  IF (SELECT status FROM rubric_versions WHERE id = NEW.rubric_version_id) <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Rubric is read-only: edit the draft instead';
  END IF;
END;

CREATE TRIGGER trg_rc_before_update BEFORE UPDATE ON rubric_criteria FOR EACH ROW
BEGIN
  IF NEW.rubric_version_id <> OLD.rubric_version_id
     OR (SELECT status FROM rubric_versions WHERE id = OLD.rubric_version_id) <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Rubric is read-only: edit the draft instead';
  END IF;
END;

CREATE TRIGGER trg_rc_before_delete BEFORE DELETE ON rubric_criteria FOR EACH ROW
BEGIN
  IF (SELECT status FROM rubric_versions WHERE id = OLD.rubric_version_id) <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Rubric is read-only: edit the draft instead';
  END IF;
END;

CREATE TRIGGER trg_rsl_before_insert BEFORE INSERT ON rubric_scale_levels FOR EACH ROW
BEGIN
  IF (SELECT status FROM rubric_versions WHERE id = NEW.rubric_version_id) <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Rubric is read-only: edit the draft instead';
  END IF;
END;

CREATE TRIGGER trg_rsl_before_update BEFORE UPDATE ON rubric_scale_levels FOR EACH ROW
BEGIN
  IF NEW.rubric_version_id <> OLD.rubric_version_id
     OR (SELECT status FROM rubric_versions WHERE id = OLD.rubric_version_id) <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Rubric is read-only: edit the draft instead';
  END IF;
END;

CREATE TRIGGER trg_rsl_before_delete BEFORE DELETE ON rubric_scale_levels FOR EACH ROW
BEGIN
  IF (SELECT status FROM rubric_versions WHERE id = OLD.rubric_version_id) <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Rubric is read-only: edit the draft instead';
  END IF;
END;

-- The pointers must match the versions' states.
CREATE TRIGGER trg_rubric_before_update BEFORE UPDATE ON rubric FOR EACH ROW
BEGIN
  IF NEW.published_version_id IS NOT NULL
     AND (SELECT status FROM rubric_versions WHERE id = NEW.published_version_id) <> 'published' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The active rubric must point at a published version';
  END IF;
  IF NEW.draft_version_id IS NOT NULL
     AND (SELECT status FROM rubric_versions WHERE id = NEW.draft_version_id) <> 'draft' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The rubric draft must point at a draft version';
  END IF;
  IF OLD.published_version_id IS NOT NULL AND NEW.published_version_id IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'A published rubric cannot be unpublished';
  END IF;
END;

CREATE TRIGGER trg_rubric_no_delete BEFORE DELETE ON rubric FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'The competition rubric row cannot be deleted';
