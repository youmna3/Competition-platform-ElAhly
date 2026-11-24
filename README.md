# iSchool x Al Ahly Judging Platform

A local judging application using React, Express and MySQL/MariaDB. Phases 0-8,
UI improvements, authenticated judge leaderboards and administrator submission
corrections, versioned Actual/Bonus rubrics and administrator reports are implemented.
Production packages, security settings and controlled deployment steps are documented
in [deploy/README.md](deploy/README.md). No public deployment is performed automatically.

## Repository and workspaces

Run npm commands from the repository root. One root lockfile governs all three workspaces.

| Workspace | Responsibility                                                                        | Build output       |
| --------- | ------------------------------------------------------------------------------------- | ------------------ |
| `client/` | React UI, routing, forms, five-star scoring and API calls                             | `client/dist/`     |
| `server/` | Express API, authentication, permissions, MySQL services, audit and operational tools | `server/dist/src/` |
| `shared/` | Type contracts, labels, validation rules, exact ranking and weighted calculations     | `shared/dist/`     |

`server/migrations/` contains the ordered SQL history. Do not rename, rewrite,
squash or remove migrations 001-010: the migration runner verifies checksums.
`server/scripts/` contains database/recovery tools; `scripts/` contains the Node
version check and source packager. Tests live beside their workspace under `test/`.
The detailed Phase 8 rules and demo dataset are in [docs/phase8-results.md](docs/phase8-results.md);
its admin-only detail routes remain restricted, while judges now have `/leaderboard`.

## Requirements and installation

- Node.js **24.x LTS** and its bundled npm. Versions outside 24.x are rejected.
- XAMPP MySQL/MariaDB (or compatible local server); Apache is not required.
- For backups/restores: `mysqldump.exe` and `mysql.exe`, normally in `C:/xampp/mysql/bin`.

```powershell
cd "D:/ischool/Judging-Platform Ahly/judging-platform-local"
node -v
npm -v
npm ci
```

If this computer still selects another Node version, choose Node 24 before installing.
The previously installed portable runtime can be selected for one PowerShell session:

```powershell
$env:Path = "$env:LOCALAPPDATA/ischool-tooling/node-v24.22.3-win-x64;$env:Path"
```

On a new installation only, copy the safe template:

```powershell
Copy-Item server/.env.example server/.env
```

Do not overwrite an existing `.env`. The source ZIP intentionally contains no real
configuration, database backups, credentials or generated build output.

## Database and authentication configuration

Configure `server/.env` locally:

- `DB_HOST`, `DB_PORT`, `DB_NAME`: the local database endpoint and name.
- `DB_USER`, `DB_PASSWORD`: runtime account; prefer a least-privilege application user.
- `DB_ADMIN_USER`, `DB_ADMIN_PASSWORD`: migration/backup account, not browser configuration.
- `MYSQL_BIN_DIR`: directory containing MySQL command-line tools; auto-detects XAMPP when possible.
- `BACKUP_DIR`: local backup directory (default `backups/` at the repository root).
- `SESSION_SECRET`: generate with `npm run auth:secret` and store it only in the local environment.
- `ADMIN_EMAIL`, `ADMIN_FULL_NAME`: initial administrator for a new database.
  Leaving `ADMIN_INITIAL_PASSWORD` empty generates a temporary password during setup.

Never put secrets in client source or any `VITE_*` setting. Environment variables
already present in the process override values loaded from the local environment file.

For a **new empty installation**, start MySQL in XAMPP and run:

```powershell
npm run auth:secret
# Save the generated value as SESSION_SECRET in server/.env.
npm run db:setup
npm run db:check
```

Setup creates the database if necessary, applies migrations and creates the initial
admin only if absent. Save the generated temporary password and change it at sign-in.
`npm run db:app-user` provisions a restricted runtime database user; follow its printed
instructions on a new installation. Do not run it as part of routine cleanup.

For an existing installation, preserve its credentials and data. Back up before an
intentional schema upgrade, stop the API, then apply only pending migrations:

```powershell
npm run db:backup
npm run db:migrate
npm run db:check
```

Never use `db:reset`, `db:restore` or demo reseeding as an upgrade step.

To check which rubric versions your evaluations use, run the read-only report:

```powershell
npm run db:rubric-check
```

It lists every rubric version, the competition's locked version, evaluations per version,
active teams whose assigned judges used more than one version, and assigned evaluations that
are not on the locked (or published) version. It never changes data. Exit code 0 means
consistent; 2 means it found something to review.

## Running and using the application

```powershell
npm run dev
```

Open `http://127.0.0.1:5173`. The API listens on `127.0.0.1:4000`; Vite proxies `/api`.
Keep MySQL running. The application uses local assets and has no CDN requirement.

Administrators manage users, teams, assignments and the rubric, review evaluations,
monitor judge progress and inspect detailed results. Admins assigned to teams also
use My Teams under the same judging rules. Judges see only their assigned teams,
the published rubric and the read-only competition leaderboard.

- Legacy rubric versions retain four Actual sections and eight required 1-5 star ratings.
- New drafts support 1-10 sections, with 1-10 equally weighted 1-5 star questions per section. Actual
  weights are whole percentages totalling exactly 100%; publishing is blocked otherwise.
- Each Bonus section explicitly configures 1-100 maximum whole points. Bonus does
  not consume Actual weight and is added above 100 without a silent cap.
- Section points = sum of star ratings / (question count x 5) x Actual weight or Bonus maximum.
  Example: base 85/100 + Bonus ratings 3 and 4 with maximum 10 gives +7/10,
  combined 92/110. All fives gives 110/110. Backend calculations are authoritative.
- Bonus is optional (approved policy for new versions): leave all ratings blank
  for zero; if started, every question must be rated before submission. Skip bonus clears
  all ratings. Actual ratings remain required. Existing versions are not rescored.
- Drafts autosave. Submission locks judge editing. An admin can formally reopen an
  evaluation for the judge to edit and resubmit, retaining its original rubric.
- Teams are archived instead of deleted. Removed assignments retain past evaluations.
- Team import accepts the downloadable XLSX/CSV templates on the import page.
- Create/Edit Team captures two required student names, an optional third student,
  Presentation Link and Project Website Link. Links are optional HTTP/HTTPS URLs
  without embedded credentials. Assigned judges see these details on their team
  cards and evaluation pages; external links open in a separate tab.
- The XLSX/CSV templates include `Student 1 Name`, `Student 2 Name`,
  `Student 3 Name`, `Presentation Link` and `Project Website Link`. When supplied,
  student columns require two or three nonempty names. Legacy three-column files
  remain supported and preserve existing student/link details; a blank link in a
  supplied link column clears that link. Existing-team updates require confirmation.
- Team-based CSV/XLSX reports append the three student names and two links. These
  are current team details; immutable evaluation snapshots and scores are unchanged.
  Migration 016 adds nullable team fields so existing teams remain usable without
  invented names. Apply pending migrations before running the updated server.
- Password recovery for an existing account uses `npm run auth:reset-password -- admin@example.com`
  and the tool's confirmation prompt (this deliberately replaces that account password). There is no public sign-up.

### Leaderboard and dashboard

Official team scores average the completed submissions of currently assigned judges
with equal weight, including assigned administrators. Drafts, reopened submissions,
unassigned judges and archived teams are excluded from official results.

A team is ranked only when every assigned judge submitted compatible evaluations
and no blocker exists. Cross-version incompatibility and stored-score discrepancies
block official ranking. Provisional scores stay separate. Exact ties share ranks
(1, 1, 3); displayed scores are rounded only for presentation.

Admins use `/admin/leaderboard`; judges use `/leaderboard`. The judge-facing API
requires authentication and excludes individual judge ratings, notes and history.
Search, sort and refresh are supported. Dashboard and leaderboards compute from the
stored ratings and refresh periodically; corrections invalidate the open client's caches.

### Rubric versions, restoration and new sections

Rubric Management shows **Rubric Version History**, publication dates, previews,
and the version **active for NEW evaluations**. A version with zero evaluations
is still preserved. Normal evaluation details are read-only until Edit Submission.

To restore version 1 while version 2 remains active, choose **Restore as New Draft**
beside version 1. Finish or discard an existing draft first. Review the copied
content, descriptions, guidelines, weights and Bonus settings, then save and publish.
Publication creates a NEW immutable version; it never overwrites an earlier one or
moves evaluations. Existing draft and submitted evaluations keep their pinned version.

In an unpublished draft choose **Add section**, then **Actual** or **Bonus**.
New sections start with two questions. Use Add Question, Remove and Move up/down to configure 1-10 questions; stable IDs survive reordering. Add a fifth Actual section by adjusting all
Actual weights back to 100%; the editor shows remaining/excess weight. Configure
Bonus maximum points separately. Sections can be removed or their type changed
in a draft. Existing section/criterion database IDs survive draft saves. Restored
copies receive new IDs in their new version. Mixed-version ranking checks remain.
Migration 011 adds versioned scoring metadata and publication guards; migrations
001-010 and existing evaluations are unchanged. Always back up before migrating.

Migration 012 adds scoring format 3 for flexible-question drafts and widens score
storage to 12 decimal places. It does not rescore existing evaluations or rewrite
snapshot JSON. Formats 1 and 2 retain their original two-question validation.
Question maximum contribution is section weight (or Bonus maximum) divided by
question count. New variable-count calculations do not round intermediate sections.
Rank comparisons use integer units on a common denominator supporting all counts
1-10, then compare team averages exactly. Display alone uses two decimals.
New drafts and restored copies use format 3; older published versions stay immutable.

### Official 2026 numeric-points rubric (Stage 3)

Migration 014 adds **scoring format 4: numeric points**. Each criterion is scored
with a whole number from **0 to its own maximum** (0 is a valid score; blank means
not scored yet). A section's score is the sum of its criteria and the final score
is the sum of the sections. Points rubrics have no Bonus sections, and all criteria
must total exactly 100 before publishing (also enforced by the database). Older star
rubric versions and their evaluations, snapshots and history are unchanged and keep
scoring with stars.

In **Rubric Management** choose **Load Official 2026 Rubric**. It fills a **draft**
with the 4 sections and 12 criteria of the official judging criteria document
(A 30, B 25, C 25, D 20 points), copied verbatim. If a draft already exists you are
asked before its content is replaced. Nothing is published automatically: review the
draft, use **Preview**, then **Publish…** yourself while the competition is in
Preparation. The scoring method can also be switched per draft in the editor
(Numeric points or Stars); points drafts stay points drafts when restored.

Judges see large point inputs with − / + steppers (arrow keys, Home/End also work),
the maximum beside each criterion, live section subtotals, the running total out
of 100 and a confirmation before submitting. Administrator corrections, team
averages, the leaderboards and the Excel/CSV reports use the same server-side
calculation (the Criteria sheet now includes each criterion's maximum).

Before upgrading an existing installation:

```powershell
npm run db:backup
npm run db:migrate
npm run db:rubric-check
```

### Administrator reports (Phase 9)

Open **Reports** in the administrator navigation. Choose a report, optional filters,
and **Download Excel (.xlsx)**. Workbooks include generation timestamps and filters.
**Download CSV** exports the selected normalized sheet, with metadata on every row.

| Report                       | Sheets / contents                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Competition Results          | Official ranks, team/project, assigned judges, submissions, base/Bonus/combined averages, maximum, completion, version and eligibility |
| Individual Judge Evaluations | Evaluation summaries, section scores/notes and criterion stars/notes in separate sheets; includes historical/unassigned records        |
| Judging Progress             | Active team completion and blockers, judge workload (including zero workload), archived team assignments/status                        |
| Admin Corrections            | Full history, administrator/reason/time, normalized Before/After details and complete immutable snapshot JSON                          |
| Rubric History               | Every version, publication/active status, section types/weights/Bonus limits, criteria, descriptions and guidelines                    |

Results use the same backend eligibility and exact ranking as the leaderboard;
filtering does not recompute official ranks or remove a judge from a team average.
Teams from incompatible versions are provisional with blank official ranks.
Historical/unassigned evaluations never automatically enter official results.
Date filters apply to submission time or correction time as labelled; input is local
browser time and exported timestamps are UTC. Numeric team IDs are record IDs from
team-page URLs. CSV sheet selection preserves all normalized data across downloads.

Excel cells are literal strings or numeric values (never formulas/macros). CSV
quotes text and prefixes dangerous formula-leading strings with an apostrophe.
Long correction JSON is split into numbered 30,000-character chunks: concatenate
chunks for the same event and Before/After side in order to reconstruct it exactly.
No correction snapshots are silently truncated or omitted.

Exports are admin-only, read-only consistent database snapshots. One export runs
at a time. Safety limits: 2,500 evaluations/correction events per export, 5,000 total
teams, 32 MB of cell text, 1 million cells, and 100,000 rows per Excel sheet. Narrow
filters when a limit is reached; the server rejects the export instead of dropping
records. XLSX uses built-in Node compression and OOXML; no new runtime dependency.
Bulk judge import is not implemented: available repository documentation and the
provided previous UI request do not establish it as agreed Phase 9 scope. Existing
single-user management and team import remain available.

### Administrator submission corrections

Open Evaluations, select a submitted evaluation, then **Edit Submission**.
Admins may correct another judge's submission or their own, without assignment or
reopening. All ratings in the original rubric, criterion notes, section notes and overall comments
are editable using the original rubric. Status stays Submitted.

1. Change values and enter a reason of 5-500 characters.
2. Choose Review changes. The Before column uses the captured original submitted
   values, including the persisted score; After shows recalculated changes.
3. Explicitly confirm. The backend validates, locks, recalculates and saves atomically.

Each correction appends immutable before/after snapshots, old/new totals, the admin,
time and reason. Earlier submission snapshots and audit records remain intact. The
review page and judge view show the last administrator modification time.

The editor captures its baseline and row version when opened. Background refreshes
cannot silently replace them. A stale save returns a conflict and retains unsaved
input. Reload current data while keeping edits, or explicitly discard edits. Either
choice requires a new comparison review before saving. Reloading is refused if the
evaluation was reopened; close the editor and review the current draft instead.

Historical submissions on Evaluations finds submitted evaluations for archived teams
or unassigned judges. Corrections do not reactivate teams, restore assignments or
change ranking eligibility. Judges still cannot edit Submitted evaluations themselves.

### Demo mode

If an existing `server/.env.demo` is configured, use `npm run demo:dev` to run against
that separate demo database. Stop another dev server first to avoid port conflicts.
`npm run db:demo` creates/rebuilds a marked demo dataset and prints its demo logins;
run that only when deliberately initializing/reseeding demo data. Do not use it for
routine verification of an existing competition or demo database.

## Backup and restore

```powershell
npm run db:backup
```

Keep each SQL backup and its `.sha256` companion together in secure storage. Backups
can contain accounts, ratings, notes and history; never commit or distribute them.
The original ZIP and existing backups are not removed by packaging.

`npm run db:restore-check` performs a restore drill in a separately named scratch
database and verifies the copy. It reserves suffix space, refuses existing scratch
names and checks that the target differs from the live database.

Actual recovery is **destructive** and is not part of tests or ordinary startup:
stop the API and intentionally run `npm run db:restore -- "path/to/backup.sql"`.
The tool checks the checksum, requires database-name confirmation and makes a
pre-restore backup. Only use it when deliberately replacing the configured database.

## Verification and database-test safety

```powershell
npm run check
npm run test:db
npm run build
npm audit
```

`check` covers TypeScript, ESLint, formatting, package checks and all unit/UI tests.
Database tests require a reachable MySQL server and an account authorized to create
scratch databases. Initial connection-health tests only read the configured database.
Destructive cases use guarded, process-owned scratch databases, never the application
or demo database. Existing scratch names are refused rather than adopted.

Test names reserve room for `_test` and `_test_restore` before truncating and hash the
full application name. Production mode, invalid/system names and foreign targets
are rejected. Every guarded test connection checks its selected database before SQL;
database switching and cross-database mutations are refused. Scratch resources created
by tests are cleaned up. Do not run multiple DB suites against the same config at once.

Regression tests cover long names/collisions, restore-drill naming, stale admin saves,
background refreshes, preserved drafts, explicit reload, original rubric/history,
permissions, exact ranks, scoring and existing judging workflows.

## Reproducible source packages and Git integrity

```powershell
npm run package:source
```

Outputs under ignored `artifacts/`:

- `ischool-ahly-source.zip`
- `ischool-ahly-source.zip.sha256`
- `source-manifest.json` listing every packaged file, byte count and SHA-256

The packager uses explicit source/configuration allowlists, sorted paths and fixed ZIP
timestamps. Identical source produces identical ZIP bytes with the same Node runtime.
It includes source from all workspaces, manifests, the lockfile, assets, import/test
fixtures, migrations 001-016, tests, the safe environment example and Markdown docs.
It checks required files even when they have not yet been added to Git.

Real environment files, backups, Git metadata, dependencies, build output, screenshots,
logs, caches, temporary files and private keys are excluded. Symlinks/path traversal
are refused. Content is screened for private-key/token patterns, nonempty example
credentials and accidentally copied local credential values (without printing them).
Synthetic test passwords remain in tests; they are not live accounts or credentials.
Screenshots/verification captures remain local evidence, not runtime/source dependencies.

Extract the ZIP to a fresh folder and run `npm ci` then `npm run build`. No database
or real environment file is required to install/build. Configure the new copy locally
only if you intend to run it; never copy the competition credentials into a shareable ZIP.
See [docs/git-additions.md](docs/git-additions.md) for the explicit source-only Git list.
Nothing is automatically staged, committed, pushed or published.

## Built deployment requirements

Build on Node 24 with development tools installed, then start with `npm start`.
The existing start command serves the API and built browser app from one origin.
Preserve workspace-relative paths and include:

- `server/dist/src/`, `client/dist/` (assets/templates included), and `shared/dist/`
- root/workspace package manifests, root lockfile and `scripts/check-node.mjs`
- Node 24 and production dependencies installed from the lockfile
- private runtime configuration supplied separately and a reachable MySQL/MariaDB database

Do not remove `shared/dist/`: the shared package exports resolve there. Do not deploy
just the browser build; it needs the Express API. TypeScript source, tests and screenshots
are unnecessary for a runtime-only package, but retain all migration SQL with the release.
Production packages include compiled maintenance tools. Use the documented
`production:migrate`, `production:backup` and recovery commands without installing
development tools. The original `db:*` commands remain development/source commands.

Development defaults bind to loopback and plain local HTTP. Production requires
validated HTTPS/proxy settings and a restricted database account. Follow the production
runbook before release; local credentials and backups are excluded from deployment ZIPs.

## Competition lifecycle and guarded reset

Open **Settings → Competition lifecycle** as an administrator. New installations and
migration 013 begin in **Preparation**; existing competition records are retained.
Publish a valid rubric, finish/discard any draft, add active teams and assign at least
one active judge to every active team. Three judges per team are recommended; Settings
lists active teams with fewer than three as a warning, but smaller panels can still be judged
and ranked. Administrator corrections and reopening are available only while the
competition is **Judging Open**; in other states the Evaluations screens say so and link here. Resolve assigned evaluations using other rubric
versions before starting. Starting requires confirmation and locks the currently
published rubric. Every new evaluation uses that version. During **Judging Open**,
judges can save/submit, and administrators can correct each submitted evaluation with
a reason and immutable Before/After history, or reopen it through the audited workflow.
Rubric publication, activation, restoration and draft management are locked.

**Close competition** requires confirmation. Closing is one-way: judging, administrative
corrections, reopening, team/assignment and account management are blocked. Leaderboard,
reports and evaluation history remain readable. Backend transactions enforce lifecycle
rules and serialize transitions with evaluation writes. Reset is the only application
workflow that returns a closed competition to Preparation.

**Settings → Danger Zone → Reset Competition** is available only to the active
administrator `youmna54@gmail.com`. The password is verified afresh for both preview and
execution, with rate limiting. Preview locks competition records briefly, creates a full
SQL backup with routines/triggers, verifies completion and SHA-256, and shows deletion
counts. Projects are stored on teams, so their preview count equals the team count.
All other users (including other administrators), teams, assignments, evaluations,
notes/ratings, submission and correction histories, audit events and rubric versions
are deleted only after the exact phrase `RESET JUDGING PLATFORM` and a separate final
confirmation. Governorate lookup data, singleton settings, schema/migrations, triggers
and constraints remain. The preserved administrator keeps the same password hash,
role and account identity; all sessions are invalidated and sign-in is required again.

Reset execution is **disabled by default**, including on the real database. Do not enable
it until the owner has explicitly approved the reviewed backup and deletion preview.
After approval, an operator can set `$env:COMPETITION_RESET_ENABLED='true'` in the server's
PowerShell session and restart the application. Remove that process variable and restart
to disable execution again. This does not require editing any credentials or `.env` file.
Preview tokens expire after ten minutes, are bound to the requesting login session and
become invalid on server restart. Any competition data/credential/schema change requires
a new preview and backup; record counts alone are not trusted. Do not make edits between
preview and execution.

Maintenance uses the configured database endpoint/name plus a database-specific instance
identity; request bodies cannot choose a target. An unexpected table or non-InnoDB table
causes refusal until reviewed. The dedicated `reset_competition` procedure runs inside a
verified maintenance transaction with child-first deletion. Definer-owned, connection-bound
maintenance context permits just that transaction to delete otherwise protected rows.
It never disables triggers/foreign keys, truncates tables or drops/recreates the database.
A failure rolls back both data and maintenance authorization. The normal runtime account
must have **no access** to `maintenance_*` tables and **no EXECUTE** grant on the reset
procedure. Run the existing `db:app-user` command after migrations to refresh least-privilege
grants; do not grant database-wide privileges to that account. Maintenance needs the
existing `DB_ADMIN_USER`/`DB_ADMIN_PASSWORD` tool configuration (falling back to `DB_USER`),
and working `mysqldump`/`mysql` binaries. No credentials are exposed to the browser.

Backups and an append-only external `maintenance.jsonl` log are stored below
`BACKUP_DIR/competition-maintenance`, outside web assets/source packages. On Windows the
folder ACL is restricted to the process user, SYSTEM and Administrators; on POSIX it is
owner-only. Failure to secure or durably write the log prevents deletion. Preserve this
folder on durable storage. Entries include the target instance, requester, counts and
backup checksum, never passwords. A crash between `commit_pending` and `completed` needs
operator reconciliation: inspect the preserved backup, lifecycle version and row counts;
do not automatically retry or reset. The external log is intentionally not cleared.

### Restore a reset backup on Windows

Stop the API and all writers. Keep both the `.sql` file and its `.sha256` sidecar; never
edit either. Test restoration in an isolated database first. After approving recovery,
run from the project root (replace the path with the reviewed backup):

```powershell
npm run db:restore -- --in-place "D:\path\to\reviewed-backup.sql"
```

Type the configured database name when prompted. The tool verifies the checksum,
creates a separate pre-restore safety backup, and restores tables/routines/triggers into
the existing configured database without dropping/recreating the database itself.
Restoration involves DDL and is not atomic: keep the application stopped until it has
completed successfully. It restores the backup's lifecycle and data, including user
accounts. Before restarting the API, select the restored application database in
phpMyAdmin, open its SQL tab, and invalidate the restored sessions:

```sql
START TRANSACTION;
UPDATE sessions SET expires = 0, data = NULL;
UPDATE users SET session_epoch = session_epoch + 1;
COMMIT;
```

These statements preserve password hashes and roles. If import fails, keep writers
stopped and recover from the verified backup rather than continuing with a partial
schema. Preserve the external maintenance log throughout recovery. Restart the API,
sign in again and check lifecycle, teams, evaluation history and reports before
allowing judging to resume.
