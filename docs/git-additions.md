# Proposed source-only Git additions

This is a review list, not a staging script. No files have been staged, committed,
pushed or published as part of the cleanup. Preserve the existing UI, leaderboard
and submission-correction work alongside the new safety fixes.

## New required source files

- `client/src/pages/admin/evaluations/EditSubmission.tsx`
- `client/src/pages/admin/evaluations/HistoricalSubmissions.tsx`
- `client/src/pages/judge/CompetitionLeaderboardPage.tsx`
- `docs/git-additions.md`
- `scripts/package-source.mjs`
- `scripts/package-source.test.mjs`
- `server/migrations/010_admin_corrections.sql`
- `server/src/db/scratchName.ts`
- `server/test/databaseSafety.test.ts`
- `server/test/databaseSafety.ts`
- `server/test/db/safety.db.test.ts`
- `server/test/userConflict.test.ts`

The first four previously untracked implementation files (the editor, historical
submission browser, judge leaderboard and migration 010) are required, not temporary
artifacts. Migration 010 and all earlier migrations remain byte-for-byte unchanged.

## Modified tracked files to review with the source changes

- `.gitignore`
- `.prettierignore`
- `README.md`
- `client/index.html`
- `client/src/App.tsx`
- `client/src/components/AppLayout.tsx`
- `client/src/components/FullPageSpinner.tsx`
- `client/src/components/HealthPanel.tsx`
- `client/src/components/Modal.tsx`
- `client/src/components/ui.tsx`
- `client/src/index.css`
- `client/src/pages/admin/AdminDashboardPage.tsx`
- `client/src/pages/admin/evaluations/EvaluationReviewPage.tsx`
- `client/src/pages/admin/evaluations/EvaluationsPage.tsx`
- `client/src/pages/admin/evaluations/JudgeProgressPage.tsx`
- `client/src/pages/admin/results/LeaderboardPage.tsx`
- `client/src/pages/admin/results/charts.tsx`
- `client/src/pages/admin/rubric/RubricEditor.tsx`
- `client/src/pages/admin/rubric/RubricManagementPage.tsx`
- `client/src/pages/admin/teams/TeamDetailsPage.tsx`
- `client/src/pages/admin/teams/TeamImportPage.tsx`
- `client/src/pages/admin/teams/TeamsPage.tsx`
- `client/src/pages/admin/teams/dialogs.tsx`
- `client/src/pages/admin/users/UsersPage.tsx`
- `client/src/pages/admin/users/dialogs.tsx`
- `client/src/pages/auth/ChangePasswordPage.tsx`
- `client/src/pages/auth/LoginPage.tsx`
- `client/src/pages/judge/EvaluationPage.tsx`
- `client/src/pages/judge/JudgeTeamsPage.tsx`
- `client/src/pages/rubric/RubricView.tsx`
- `client/src/pages/rubric/ViewRubricPage.tsx`
- `client/test/results.test.tsx`
- `client/test/review.test.tsx`
- `client/test/teams.test.tsx`
- `eslint.config.js`
- `package.json`
- `server/.env.example`
- `server/scripts/db-restore-check.ts`
- `server/src/evaluations/routes.ts`
- `server/src/evaluations/service.ts`
- `server/src/results/routes.ts`
- `server/src/results/service.ts`
- `server/src/review/routes.ts`
- `server/src/review/service.ts`
- `server/src/routes/protected.ts`
- `server/src/users/service.ts`
- `server/test/db/appUser.db.test.ts`
- `server/test/db/auth.db.test.ts`
- `server/test/db/backup.db.test.ts`
- `server/test/db/demoSeed.db.test.ts`
- `server/test/db/helpers.ts`
- `server/test/db/judging.db.test.ts`
- `server/test/db/results.db.test.ts`
- `server/test/db/review.db.test.ts`
- `server/test/db/rubricManagement.db.test.ts`
- `server/test/db/teams.db.test.ts`
- `server/test/db/users.db.test.ts`
- `shared/src/evaluations.ts`
- `shared/src/results.ts`
- `shared/src/review.ts`
- `shared/src/users.ts`

## Excluded from staging and source packages

- Real `server/.env` and `server/.env.demo`; local credential values.
- `backups/` and SQL/checksum backup pairs. Retain them securely; do not delete them.
- The original sibling `judging-platform-local.zip`; retain it, do not distribute it.
- `.git/`, all `node_modules/`, `dist/`, caches, coverage and logs.
- `artifacts/` ZIPs, package manifests/checksums and fresh-copy verification output.
- `docs/screenshots/` generated visual/verification evidence, retained locally.

`server/.env.example` is a reviewed placeholder template and belongs in Git. The root
`package-lock.json`, assets/templates and test fixtures also belong in Git. Synthetic
fixture passwords are test data, not production account credentials.

Use `git status --short` and inspect the diff before selecting paths. Do not use a
blanket `git add .` without review. Adding sources to Git and publishing a repository
are separate actions; no push or publication is authorized by this list.
