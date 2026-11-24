-- Add team members and project resources without changing existing team/evaluation records.
ALTER TABLE teams
  ADD COLUMN student_name_1 VARCHAR(200) NULL,
  ADD COLUMN student_name_2 VARCHAR(200) NULL,
  ADD COLUMN student_name_3 VARCHAR(200) NULL,
  ADD COLUMN presentation_link VARCHAR(2048) NULL,
  ADD COLUMN project_website_link VARCHAR(2048) NULL,
  ADD CONSTRAINT chk_team_students CHECK (
    (student_name_1 IS NULL AND student_name_2 IS NULL AND student_name_3 IS NULL)
    OR (student_name_1 IS NOT NULL AND CHAR_LENGTH(TRIM(student_name_1))>0
      AND student_name_2 IS NOT NULL AND CHAR_LENGTH(TRIM(student_name_2))>0
      AND (student_name_3 IS NULL OR CHAR_LENGTH(TRIM(student_name_3))>0))
  ),
  ADD CONSTRAINT chk_team_presentation_link CHECK (presentation_link IS NULL OR presentation_link LIKE 'https://%' OR presentation_link LIKE 'http://%'),
  ADD CONSTRAINT chk_team_website_link CHECK (project_website_link IS NULL OR project_website_link LIKE 'https://%' OR project_website_link LIKE 'http://%');
