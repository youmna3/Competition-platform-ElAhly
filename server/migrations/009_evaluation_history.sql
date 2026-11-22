-- =============================================================================
-- 009 Evaluation history and reopening (additive; no existing data changes)
--
-- * evaluation_events is an append-only history per evaluation: started,
--   occasional draft revisions, every submission with an immutable snapshot of
--   its ratings, notes and score, and every reopening with who, when and why.
--   Rows can never be updated or deleted.
-- * evaluations gains save counters and the latest reopening, plus a flag that
--   tells the judge their evaluation was reopened.
-- * Existing evaluations get "started" (and "submitted") history rows so their
--   timeline is complete. Their own rows are not modified.
-- =============================================================================

CREATE TABLE evaluation_events (
  id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  evaluation_id      INT UNSIGNED NOT NULL,
  event              ENUM('started','draft_saved','submitted','reopened','resubmitted') NOT NULL,
  actor_id           INT UNSIGNED NULL,
  actor_email        VARCHAR(254) NULL,
  rubric_version_id  INT UNSIGNED NOT NULL,
  row_version        INT UNSIGNED NOT NULL,
  rated_count        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  total_score        DECIMAL(12,3) NULL,
  previous_score     DECIMAL(12,3) NULL,   -- reopened / resubmitted: the score being replaced
  reason             VARCHAR(500) NULL,     -- reopened: why
  snapshot           LONGTEXT NULL,         -- submitted / resubmitted: ratings, notes, scores (JSON)
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_ee_evaluation (evaluation_id, id),
  KEY ix_ee_event (event, created_at),
  CONSTRAINT chk_ee_snapshot CHECK (snapshot IS NULL OR JSON_VALID(snapshot)),
  CONSTRAINT chk_ee_reason CHECK (event <> 'reopened' OR CHAR_LENGTH(TRIM(reason)) >= 5),
  CONSTRAINT fk_ee_evaluation FOREIGN KEY (evaluation_id) REFERENCES evaluations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ee_version FOREIGN KEY (rubric_version_id) REFERENCES rubric_versions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TRIGGER trg_ee_no_update BEFORE UPDATE ON evaluation_events FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Evaluation history is append-only';

CREATE TRIGGER trg_ee_no_delete BEFORE DELETE ON evaluation_events FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Evaluation history is never deleted';

ALTER TABLE evaluations
  ADD COLUMN save_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER row_version,
  ADD COLUMN last_saved_at DATETIME NULL AFTER save_count,
  ADD COLUMN reopened_at DATETIME NULL AFTER reopened_count,
  ADD COLUMN reopened_by INT UNSIGNED NULL AFTER reopened_at,
  ADD COLUMN reopen_reason VARCHAR(500) NULL AFTER reopened_by,
  ADD COLUMN reopen_notice_pending BOOLEAN NOT NULL DEFAULT FALSE AFTER reopen_reason,
  ADD CONSTRAINT fk_evaluations_reopened_by FOREIGN KEY (reopened_by) REFERENCES users (id) ON DELETE SET NULL;

-- Complete the timeline of evaluations that already exist.
INSERT INTO evaluation_events (evaluation_id, event, actor_id, actor_email, rubric_version_id, row_version, created_at)
SELECT e.id, 'started', e.judge_id, u.email, e.rubric_version_id, 1, e.created_at
FROM evaluations e JOIN users u ON u.id = e.judge_id;

INSERT INTO evaluation_events
  (evaluation_id, event, actor_id, actor_email, rubric_version_id, row_version, rated_count, total_score, created_at)
SELECT e.id, 'submitted', e.judge_id, u.email, e.rubric_version_id, e.row_version, e.required_scored, e.total_score, e.submitted_at
FROM evaluations e JOIN users u ON u.id = e.judge_id
WHERE e.status = 'submitted';
