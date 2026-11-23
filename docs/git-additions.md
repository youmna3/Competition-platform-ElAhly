# Source files to review for Git

No staging, commit, push or publication was performed by this task. Review these
source changes together; the existing client, server and shared workspaces remain.

## New Phase 9 and rubric source files to add

- `client/src/pages/admin/reports/ReportsPage.tsx`
- `client/test/reports.test.tsx`
- `server/migrations/011_dynamic_rubrics.sql`
- `server/src/reports/format.ts`
- `server/src/reports/routes.ts`
- `server/src/reports/service.ts`
- `server/test/db/dynamicRubric.db.test.ts`
- `server/test/dynamicRubric.test.ts`
- `server/test/reportFormat.test.ts`
- `shared/src/reports.ts`

## Modified tracked files to review with them

- `README.md`
- `client/src/App.tsx`
- `client/src/components/AppLayout.tsx`
- `client/src/pages/admin/evaluations/EditSubmission.tsx`
- `client/src/pages/admin/evaluations/EvaluationReviewPage.tsx`
- `client/src/pages/admin/results/LeaderboardPage.tsx`
- `client/src/pages/admin/rubric/RubricEditor.tsx`
- `client/src/pages/admin/rubric/RubricManagementPage.tsx`
- `client/src/pages/admin/rubric/model.ts`
- `client/src/pages/admin/teams/TeamDetailsPage.tsx`
- `client/src/pages/judge/CompetitionLeaderboardPage.tsx`
- `client/src/pages/judge/EvaluationPage.tsx`
- `client/src/pages/rubric/RubricView.tsx`
- `client/src/pages/rubric/ViewRubricPage.tsx`
- `client/test/results.test.tsx`
- `client/test/review.test.tsx`
- `client/test/rubric.test.tsx`
- `docs/git-additions.md`
- `scripts/package-source.mjs`
- `server/src/evaluations/service.ts`
- `server/src/results/service.ts`
- `server/src/review/service.ts`
- `server/src/routes/protected.ts`
- `server/src/rubric/routes.ts`
- `server/src/rubric/service.ts`
- `server/test/db/results.db.test.ts`
- `server/test/db/rubric.db.test.ts`
- `server/test/db/rubricManagement.db.test.ts`
- `server/test/rubricRules.test.ts`
- `shared/src/evaluations.ts`
- `shared/src/index.ts`
- `shared/src/results.ts`
- `shared/src/review.ts`
- `shared/src/rubric.ts`

## Required earlier implementation files preserved

These files are now tracked and remain required:

- `client/src/pages/admin/evaluations/EditSubmission.tsx`
- `client/src/pages/admin/evaluations/HistoricalSubmissions.tsx`
- `client/src/pages/judge/CompetitionLeaderboardPage.tsx`
- `server/migrations/010_admin_corrections.sql`

Migrations 001-010 remain unchanged. Migration 011 is additive and must travel
with the new rubric code. After applying 011, it must also remain immutable.
The root lockfile, all three workspace manifests, assets/templates, tests and safe
`server/.env.example` belong in Git and the source package.

## Keep excluded

Real `.env` and `.env.demo`, credentials, database backups, `.git`, `node_modules`,
`dist`, generated ZIPs/manifests, logs, caches, screenshots and browser exports.
Keep existing backups in secure local storage. The user confirmed moving/removing
the original sibling ZIP; this task did not delete it.

`artifacts/` contains reproducible packaging and local verification output only.
Do not use blanket staging. No credentials, backups or generated artifacts should
be staged, pushed or distributed in source ZIPs.
