-- =============================================================================
-- 001 Core tables: governorates, users, teams, assignments, audit log, sessions
-- Compatible with XAMPP MariaDB 10.4+ and MySQL 8.0.16+.
-- There are deliberately no organization, category, grade or level tables.
-- =============================================================================

CREATE TABLE governorates (
  id          TINYINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(80) NOT NULL,
  sort_order  SMALLINT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_governorates_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE users (
  id                    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email                 VARCHAR(254) NOT NULL,
  full_name             VARCHAR(200) NOT NULL,
  password_hash         CHAR(60) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  role                  ENUM('admin','judge') NOT NULL DEFAULT 'judge',
  status                ENUM('active','disabled') NOT NULL DEFAULT 'active',
  must_change_password  BOOLEAN NOT NULL DEFAULT TRUE,
  governorate_id        TINYINT UNSIGNED NULL,
  failed_login_count    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until          DATETIME NULL,
  last_login_at         DATETIME NULL,
  password_changed_at   DATETIME NULL,
  created_by            INT UNSIGNED NULL,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_email (email),                 -- case-insensitive (unicode_ci)
  CONSTRAINT chk_users_email CHECK (email LIKE '_%@_%._%'),
  CONSTRAINT chk_users_name CHECK (CHAR_LENGTH(TRIM(full_name)) > 0),
  CONSTRAINT chk_users_hash CHECK (password_hash LIKE '$2_$%'),   -- bcrypt only, never plain text
  CONSTRAINT fk_users_governorate FOREIGN KEY (governorate_id) REFERENCES governorates (id),
  CONSTRAINT fk_users_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE teams (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  team_code       VARCHAR(40)  NOT NULL,
  name            VARCHAR(200) NOT NULL,
  project_name    VARCHAR(200) NOT NULL,
  governorate_id  TINYINT UNSIGNED NULL,
  status          ENUM('active','archived') NOT NULL DEFAULT 'active',
  archived_at     DATETIME NULL,
  archived_by     INT UNSIGNED NULL,
  archive_reason  VARCHAR(500) NULL,
  created_by      INT UNSIGNED NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_teams_code (team_code),               -- case-insensitive
  KEY ix_teams_status (status),
  CONSTRAINT chk_teams_code CHECK (CHAR_LENGTH(TRIM(team_code)) > 0),
  CONSTRAINT chk_teams_name CHECK (CHAR_LENGTH(TRIM(name)) > 0),
  CONSTRAINT chk_teams_archive CHECK (
    (status = 'active' AND archived_at IS NULL) OR (status = 'archived' AND archived_at IS NOT NULL)),
  CONSTRAINT fk_teams_governorate FOREIGN KEY (governorate_id) REFERENCES governorates (id),
  CONSTRAINT fk_teams_archived_by FOREIGN KEY (archived_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_teams_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE team_judges (
  team_id      INT UNSIGNED NOT NULL,
  judge_id     INT UNSIGNED NOT NULL,
  assigned_by  INT UNSIGNED NULL,
  assigned_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (team_id, judge_id),
  KEY ix_team_judges_judge (judge_id),
  CONSTRAINT fk_team_judges_team FOREIGN KEY (team_id) REFERENCES teams (id) ON DELETE CASCADE,
  CONSTRAINT fk_team_judges_judge FOREIGN KEY (judge_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_team_judges_by FOREIGN KEY (assigned_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only history. Rows can never be updated or deleted (see triggers below).
CREATE TABLE audit_log (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  occurred_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  actor_id       INT UNSIGNED NULL,          -- no FK on purpose: history outlives account changes
  actor_email    VARCHAR(254) NULL,
  action         VARCHAR(60) NOT NULL,       -- e.g. user.seeded, rubric.published, team.archived
  entity_type    VARCHAR(40) NOT NULL,
  entity_id      VARCHAR(40) NULL,
  team_id        INT UNSIGNED NULL,
  evaluation_id  INT UNSIGNED NULL,
  ip_address     VARCHAR(45) NULL,
  details        LONGTEXT NOT NULL,          -- JSON, always written by the API
  KEY ix_audit_time (occurred_at),
  KEY ix_audit_entity (entity_type, entity_id),
  KEY ix_audit_team (team_id, occurred_at),
  KEY ix_audit_evaluation (evaluation_id, occurred_at),
  CONSTRAINT chk_audit_details_json CHECK (JSON_VALID(details))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TRIGGER trg_audit_log_no_update BEFORE UPDATE ON audit_log FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only';

CREATE TRIGGER trg_audit_log_no_delete BEFORE DELETE ON audit_log FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only';

-- Login sessions (layout expected by express-mysql-session, used from Phase 2).
CREATE TABLE sessions (
  session_id  VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
  expires     INT UNSIGNED NOT NULL,
  data        MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  KEY ix_sessions_expires (expires)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
