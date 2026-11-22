# iSchool × Al Ahly Judging Platform

A local, offline judging platform for the iSchool × Al Ahly Club competition. It runs on one Windows
computer with Node.js 24 LTS and XAMPP MySQL. No cloud services, CDNs or external accounts are used.

**Status: Phase 8 (official results) is complete.** Administrators see:

- a **Leaderboard** (administrators only, never public) with the single official ranking, ties,
  teams not yet eligible and why, and rubric-version checks;
- a **Dashboard** with real competition figures and simple progress charts.

Earlier phases: users (3), teams and assignments (4), Rubric Management (5), judging on **My teams**
(6), evaluation review and reopening (7). Full Phase 8 rules, the demo dataset and a Windows test
checklist are in [`docs/phase8-results.md`](docs/phase8-results.md).

---

## 1. Requirements (install once)

| Software            | Version      | Notes                                                                        |
| ------------------- | ------------ | ---------------------------------------------------------------------------- |
| Node.js             | **24 LTS**   | <https://nodejs.org> → "LTS" Windows installer. `node -v` must show `v24.x`. |
| XAMPP               | 8.x or newer | Only the **MySQL** module is needed. Apache is not used.                     |
| PowerShell or `cmd` | built in     | All commands below are typed in a terminal opened in the project folder.     |

`npm install` stops with a clear message on any other Node major version. That avoids
confusing errors later.

## 2. First-time setup

1. **Start MySQL.** Open the XAMPP Control Panel and click **Start** next to **MySQL**. It turns green.
2. **Open a terminal in the project folder:**

   ```powershell
   cd "D:\ischool\Judging-Platform Ahly\judging-platform-local"
   ```

3. **Install the dependencies.** This needs the internet once. After that, everything works offline.

   ```powershell
   npm install
   ```

4. **Create your settings file:**

   ```powershell
   Copy-Item server\.env.example server\.env
   ```

   The defaults match a fresh XAMPP: user `root`, empty password, `127.0.0.1:3306`, database
   `judging_platform`. If you set a password for MySQL's `root` user in XAMPP, put it in
   `DB_PASSWORD=` in `server\.env`. **Never share or commit `server\.env`.**

5. **Set up the database.** This creates the database if needed, builds all tables and creates
   the first administrator, `youmna54@gmail.com`:

   ```powershell
   npm run db:setup
   ```

   The first time, it prints a **temporary administrator password once**, in a box. Copy it somewhere
   safe now. Only a bcrypt hash is stored, so it can't be shown again. You will have to replace it at
   first sign-in (Phase 2). To choose the password yourself instead, put it in
   `ADMIN_INITIAL_PASSWORD=` in `server\.env` before running the command, then remove it after the
   first sign-in.

   Running `npm run db:setup` again is safe. It only applies new migrations and never changes an
   existing account.

6. **Create the session secret** (once). This adds a random `SESSION_SECRET` to `server\.env`. The
   API won't start without it:

   ```powershell
   npm run auth:secret
   ```

7. **Check the connection:**

   ```powershell
   npm run db:check
   ```

   Expected: `OK  connected to judging_platform on 10.4.xx-MariaDB (… ms)`. XAMPP's "MySQL" is
   MariaDB, and that is expected.

8. **Recommended: switch the API to a least-privilege MySQL account.** XAMPP's `root` can do
   anything. This creates `judging_app`, which can read and write data but can't change tables,
   delete evaluation history or edit the audit log:

   ```powershell
   npm run db:app-user
   ```

   Copy the four lines it prints into `server\.env` (they keep `root` only for setup and
   backups), restart the API, and run `npm run db:check` again.

### Upgrading from Phase 7

```powershell
npm install
npm run db:backup
```

Phase 8 adds **no database changes**: no migration and no new permissions, so `db:migrate` and
`db:app-user` are not needed (running `db:migrate` is harmless; it reports nothing to apply). Results
are calculated from the existing data each time the Leaderboard or Dashboard is opened. Taking a
backup first is still recommended.

### Upgrading from Phase 6

```powershell
npm install
npm run db:backup
npm run db:migrate
npm run db:app-user
```

`db:migrate` applies `009_evaluation_history.sql`. It adds the append-only evaluation history table and
a few columns to evaluations (save count, last save, latest reopening, a notice flag for the judge). It
also fills in the history of evaluations that already exist. No existing row is changed.

**`db:app-user` is required this time** if `server\.env` uses the `judging_app` account. That account
gets permissions table by table, and the new history table needs its own (read and add only). Without
this step, submitting an evaluation fails. The command keeps the password already in `server\.env`.

### Upgrading from Phase 5

```powershell
npm install
npm run db:backup
npm run db:migrate
```

`db:migrate` applies `008_evaluations_access.sql`. It replaces one trigger so the database also refuses
new evaluations for archived teams and disabled accounts. Existing data is not changed.

### Upgrading from Phase 4

```powershell
npm install
npm run db:backup
npm run db:migrate
```

`db:migrate` applies `007_rubric_management.sql`. It only adds columns (rubric description, section
weight, criterion guidelines, a draft revision counter) and database rules: at most one published
version and one draft, published versions can't change, and publishing requires exactly 4 sections of 2
criteria rated 1–5 stars, with section weights that total 100%. Existing data is not changed. The
rubric stays **Not configured** until you build and publish it.

### Upgrading from Phase 3

```powershell
npm install
npm run db:backup
npm run db:migrate
npm run db:app-user
```

`db:migrate` applies `006_teams.sql`. It only adds database triggers and two indexes. Existing data is
not changed. The triggers make sure teams are never deleted, and that archived teams and disabled
accounts can't receive new assignments. `db:app-user` refreshes the `judging_app` account's
permissions so it can no longer delete teams. It keeps the password already in `server\.env`. This
step is optional, because the database refuses team deletion anyway.

### Upgrading from Phase 2

```powershell
npm install
npm run db:backup
npm run db:migrate
```

`db:migrate` applies `005_user_management.sql`. It only adds two database triggers that stop the last
active administrator from being disabled, demoted or deleted. Existing data is not changed.

## 3. Run it (development)

```powershell
npm run dev
```

This starts both parts:

- API: <http://127.0.0.1:4000/api/health>
- Web app: **<http://127.0.0.1:5173>**. Open this in your browser.

The page shows the iSchool × Al Ahly header and a **System status** panel. Both tiles should say
**Connected**. If MySQL is stopped, the database tile turns red and tells you how to fix it. It
recovers by itself within 10 seconds of starting MySQL again. Stop with **Ctrl + C**.

Both servers listen on `127.0.0.1` only, so nothing is reachable from other devices. That is
intentional until HTTPS and a firewall rule are set up in a later phase.

### Signing in

Open <http://127.0.0.1:5173> and sign in.

- **Administrators** land on the **Dashboard**. **Judges** land on **My assigned teams**.
- The first sign-in with a temporary password goes straight to **Choose your own password**. Nothing
  else is available until it is changed. Passwords need at least 12 characters with upper case, lower
  case, a number and a symbol, and can't contain your e-mail name.
- A session ends after 4 hours without activity, and always after 12 hours. Change these with
  `SESSION_IDLE_MINUTES` and `SESSION_MAX_HOURS` in `server\.env`.
- After 5 wrong passwords in a row, the account is locked for 15 minutes. A device that makes 20 failed
  attempts within 15 minutes is paused, whichever accounts it tries.
- Changing your password signs you out on all other devices.

### Forgotten password or locked-out administrator

There is no e-mail. Recovery happens on the server computer, which needs the database settings in
`server\.env`:

```powershell
npm run auth:reset-password                      # resets youmna54@gmail.com (ADMIN_EMAIL)
npm run auth:reset-password -- judge@example.com # any other account
npm run auth:reset-password -- someone@example.com --enable   # also re-activates a disabled account
```

It asks you to type the e-mail to confirm, then prints a new temporary password **once**. The old
password stops working immediately, all of that account's sessions end, any lockout is cleared, and
the action is written to the audit log. Don't paste the new password into chats or shared logs. From
Phase 3, administrators can also reset judges' passwords from the Accounts page.

### Managing users (administrators)

Open **Users** in the top navigation.

- **Add user**: enter the full name and e-mail and choose Judge or Administrator. A strong temporary
  password is shown **once**. Copy it, give it to the person privately, then tick "I have copied…" and
  press Done. They must choose their own password at first sign-in.
- **Edit**: change the name, e-mail or role. A role change takes effect on the person's very next
  click.
- **Disable / Reactivate**: disabling signs the person out immediately and blocks sign-in. Their
  evaluations are kept. Reactivating lets them sign in again with their current password.
- **Reset password**: a new temporary password, shown once. The old password stops working and the
  person is signed out everywhere.
- **Search and filters**: by name or e-mail, role and status.

Safeguards:

- The last active administrator can't be disabled or demoted. The database enforces this too.
- You can't disable your own account or reset your own password from this page. Use **Change
  password** instead.
- E-mail addresses are unique, whatever the letter case.

### Managing teams (administrators)

Open **Teams** in the top navigation.

- **Add team**: Team ID, team name and project name, all required. Team IDs are unique, whatever the
  letter case, and can use letters (Arabic included), numbers, spaces and `- _ . / #`.
- **Search, filter and sort**: search by Team ID, team or project name. Filter Active, Archived or All.
  Sort by any column, including judge count and evaluation progress.
- **View**: the team's details, its assigned judges with each evaluation's status, and evaluations kept
  from judges who are no longer assigned.
- **Archive / Reactivate**: archiving hides the team from judges and blocks new assignments. Its
  assignments and evaluations are kept. Teams can't be deleted.
- **Assign judges**: from a team's page, or tick several teams in the list and choose **Assign
  judges**. Only active accounts are offered. Judges already assigned are skipped. **Remove** on a
  team's page unassigns one judge and keeps their evaluation.
- The **Users** page shows how many active teams each judge has.

### Importing teams from Excel or CSV

**Teams → Import teams**. Download the Excel or CSV template, fill in one team per row (**Team ID**,
**Team Name**, **Project Name**), then choose the file.

- You always see a preview first. Each row is marked **New**, **Update**, **No change** or **Error**,
  with the reason for each error.
- Nothing is imported while any row has an error, such as a missing value, a Team ID used twice in
  the file, or text that is too long. Fix the file and choose it again.
- A row whose Team ID already exists updates that team. The preview shows each change, and you must
  tick the confirmation box before importing.
- The import is all-or-nothing: if anything fails, nothing is saved.
- Only the first sheet is read. Extra columns are ignored and listed. Up to 2000 teams per file.

### Rubric Management (administrators)

Open **Rubric** in the top navigation.

- **Not configured**: press **Start building the rubric**. A draft opens with 4 sections of 2 criteria,
  named "Section 1", "Criterion 1" and so on, and no weights. Nothing about the competition is filled
  in for you.
- **Edit**: the rubric title, description and instructions for judges; each section's title and
  description; each criterion's title, description and judging guidelines. The number of sections and
  criteria is fixed.
- **Section weights**: use the slider or type a whole-number percentage. The total shows live as
  "x% / 100%". It must be exactly 100% to publish.
- **Scoring**: section score = (criterion 1 + criterion 2) ÷ 2 ÷ 5 × section weight. The final score is
  the four section scores added together, out of 100. Example: 4★ and 5★ in a 30% section give 27.
- **Save draft** stores your work. The page warns you before you leave with unsaved changes. If someone
  else saved the draft meanwhile, you are told to reload instead of overwriting their changes.
- **Preview** shows the rubric exactly as judges see it. You can click the stars to try the scoring;
  nothing is saved.
- **Publish…** lists the weights and asks you to confirm. Everything that still needs fixing is listed
  at the top of the page, and the Publish button stays disabled until it's done.
- **Changing a published rubric**: press **Edit rubric**. That creates a draft copy, and judges keep
  using the published version until you publish the draft. Published versions never change.
  Evaluations keep the version (and weights) they were started on, and their scores never change. If
  evaluations already exist, publishing asks you to confirm and lists the weight changes. **Discard
  draft** drops the copy.
- **Judges and administrators** see the published rubric under **Rubric** (judges) or **My teams →
  judging rubric**. It is read-only. Administrators can be assigned to teams on the Teams page and then
  judge exactly like judges. Everything is recorded in the audit log.

### Judging (judges and assigned administrators)

Open **My teams**. Each team shows **Not started**, **Draft** or **Submitted**, how many criteria are
rated (for example 5/8), and the final score once submitted.

- **Start / Continue / View** opens the team. The team's details are read-only. Press **Start
  evaluation** to begin.
- **Rate** each criterion with 1 to 5 stars. Each section's score, (rating 1 + rating 2) ÷ 10 × section
  weight, and the running total update immediately. Scores are shown with two decimals.
- **Notes** are optional, on each criterion, each section and the whole evaluation.
- **Saving** happens automatically about a second after each change. The bar at the bottom shows
  "✓ All changes saved", "Saving…" or "Not saved yet". **Save** saves immediately. If a save fails
  (for example the server stopped), your ratings stay on the page and on this computer, and saving
  retries. If you open the same evaluation in two tabs, the older tab is stopped before it can
  overwrite anything, and you choose which version to keep.
- **Submit…** checks that all 8 criteria are rated and highlights any that are missing. It then shows
  the section scores and the final score for confirmation. After submitting, the evaluation is locked
  and shown read-only with its score and time. Clicking twice never submits twice.
- If the rubric was republished after you started, the evaluation stays on the version (and weights)
  it started with, and a notice says so.
- Administrators judge only teams they are assigned to, with exactly the same rules. On **Teams**, a
  team's page shows each judge's status, rated count, score and rubric version. Teams whose
  evaluations use different rubric versions are flagged.

### Reviewing evaluations (administrators)

Open **Evaluations**.

- **By team** lists every team with its assigned judges, each judge's status and score (or how far a
  draft is), submitted and pending counts, the provisional average, the rubric versions used and the
  last submission.
  - Search by team, project or judge.
  - Filter by judge, evaluation status, team completion (including **Mixed rubric versions** and
    **Ready for results**), rubric version, or active/archived teams.
  - Sort and page through the results.
  - "Ready for results" means every assigned judge has submitted, all on the same rubric version.
- **Click a judge** to open their evaluation read-only: every star rating and note, the section weights
  of that evaluation's rubric version, the section scores, the final score, the times and the status.
  The **History** below records:
  - when it was started;
  - draft revisions, at most every 10 minutes, so autosave doesn't flood it;
  - every submission, with a permanent copy of what was submitted;
  - every reopening (who, when, why);
  - every resubmission, with the old and new scores.
- **Reopen…** (submitted evaluations only):
  - You must give a reason of at least 5 characters and confirm.
  - The evaluation goes back to Draft and stops counting as submitted.
  - The judge sees a notice with your reason. Only that judge can change it and submit it again, on the
    same rubric version.
  - Other judges' evaluations are untouched.
  - Reopening is refused while the judge is no longer assigned to the team, their account is disabled,
    or the team is archived. Restore that first.
  - Reopening your own evaluation is allowed, but you're asked to consider having another administrator
    do it, and the audit log marks it.
- **Judge progress** shows each judge (including administrators assigned as judges): active teams, not
  started, drafts, submitted, completion % and last submission. Filter by name and completion.
  Evaluations of teams a judge is no longer assigned to, or that were archived, are counted separately
  as "Other".
- A team's page (Teams → View) shows the provisional average, results readiness, the last update, and
  each judge's rubric version and weights, with a link to review each evaluation.

### Leaderboard and results (administrators)

Open **Leaderboard**. It is only available to administrators.

- **Official score** of a team = the average of the submitted final scores of every judge **currently
  assigned** to it. Every judge counts equally, administrators included. It is recalculated on the
  server from the stored star ratings every time; nothing typed in the browser is trusted.
- Scores keep full precision and are only rounded to 2 decimals for display. Two teams tie only if
  their averages are exactly equal (80.333… and 80.329 both show 80.33 but are not tied).
- **Ranking:** competition style, 1, 1, 3. Ties are never broken by time or name; tied teams are
  listed by Team ID only to keep the order stable.
- A team is **ranked** only when it is active, has at least one assigned judge, every assigned judge has
  submitted (none reopened), all on the same rubric version, and nothing blocks it.
- **Not ranked yet** lists every other active team with its status and the reason:
  - _Unassigned_: no judges.
  - _Not started_: no judge has started.
  - _In progress_: some judges are still drafting, haven't started, or an evaluation was reopened.
  - _Blocked_: an assigned judge's account is disabled, the judges used different rubric versions, or
    a stored score doesn't match its ratings. These need an administrator; they are never silently
    ignored.
  - A **provisional average** (scores submitted so far) is shown, clearly marked as not official.
- **Rubric versions:** if ready teams were scored with different rubric versions, there is **no
  official ranking**. The page explains which teams use which version and shows a separate
  _provisional comparison_ per version. Scores are never converted or rescored automatically.
  Warnings also appear when the ranking's version is no longer the published one.
- Evaluations by judges who were removed from a team, archived teams and drafts never count. They are
  kept in the database as history.
- Search by team, project or judge; sort by any column (on phones, use _Sort by_). The page refreshes
  every 30 seconds and with **Refresh**.

The **Dashboard** shows active and archived teams, judges, administrators, participating judges,
submitted / draft / not-started evaluations, completion %, teams ready, blocked and waiting, judges with
pending work, the average submitted score (descriptive only, not a result), charts of submitted vs
pending, team status and each judge's progress, and the top teams when an official ranking exists.

There is no export and no public leaderboard in Phase 8.

### Demo database for testing the results (optional)

To try every results case without touching real data:

```powershell
npm run db:demo
npm run demo:dev
```

- `db:demo` creates a **separate** database `<DB_NAME>_demo` (for example `judging_platform_demo`)
  with fictional teams, judges and evaluations. It refuses to use the real database name, and only
  ever deletes a database it created itself. Running it again resets the demo.
- It creates a MySQL account `judging_demo` that can only use the demo database and writes its
  settings to `server\.env.demo`. `server\.env` is not changed.
- It prints the demo accounts and their shared password (also saved as `DEMO_LOGIN_PASSWORD` in
  `server\.env.demo`).
- `demo:dev` starts the app on the demo database (stop the normal `npm run dev` first). System status
  shows the database name, so you can always check which one you're using. Stop it with Ctrl+C and
  start the normal app with `npm run dev`.

The expected results and a step-by-step checklist are in
[`docs/phase8-results.md`](docs/phase8-results.md).

## 4. Run it (production mode, one port)

```powershell
npm run build
npm start
```

Then open <http://127.0.0.1:4000>. Express serves the built app and the API from the same address.

## 5. Backups and restore

Do this before any real judging data is entered, and keep doing it during the competition.

| Command                                    | What it does                                                                                                                                                                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run db:backup`                        | Consistent snapshot of the database without stopping the app. Writes `backups\judging_platform_backup_<date>_<time>.sql` and a `.sha256` checksum file next to it.                                                                                 |
| `npm run db:restore-check`                 | **The restore drill.** Takes a fresh backup, restores it into a scratch database, and proves the copy is identical (row counts and checksums of every table, triggers and views). Your live data isn't touched. Run it once before judging starts. |
| `npm run db:restore -- backups\<file>.sql` | Replaces the database with a backup. Stop the API first. It verifies the checksum, asks you to type the database name, and takes a safety backup of the current data (`…_pre-restore_…sql`) before restoring.                                      |

Suggested routine: a backup before judging opens, every hour during judging, and after the final
results. Copy the `backups` folder to a USB drive at the end of each day. The tools use XAMPP's
`mysqldump.exe` and `mysql.exe` from `C:\xampp\mysql\bin`. If XAMPP is installed elsewhere, set
`MYSQL_BIN_DIR` in `server\.env`.

## 6. Database commands

| Command                                  | What it does                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `npm run db:setup`                       | Create the database if needed, apply migrations, create the first admin. Safe to repeat.                                 |
| `npm run db:migrate`                     | Apply new migrations only. `npm run db:migrate -- --status` lists them.                                                  |
| `npm run db:seed`                        | Create the first admin only (if missing).                                                                                |
| `npm run db:app-user`                    | Create or refresh the least-privilege `judging_app` MySQL account.                                                       |
| `npm run auth:secret`                    | Add a random `SESSION_SECRET` to `server\.env` if it doesn't have one.                                                   |
| `npm run auth:reset-password -- [email]` | Account recovery: new temporary password shown once, all sessions ended, lockout cleared.                                |
| `npm run db:check`                       | Test the connection with the API's settings.                                                                             |
| `npm run db:reset -- --yes`              | **Development only:** delete everything and rebuild an empty database. Refused when `NODE_ENV=production`.               |
| `npm run db:demo`                        | Create or reset the separate demo database `<DB_NAME>_demo` with the Phase 8 test data. Never touches the real database. |
| `npm run demo:dev`                       | Run the development servers against the demo database.                                                                   |

## 7. Tests and checks

| Command             | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`     | Type checking, lint, formatting check and all unit tests. Run before every commit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `npm test`          | Unit tests: 36 server tests (including the scoring formula, rubric rules and the exact ranking rules) and 73 UI tests (sign-in, route guards, password change, Users, Teams and Rubric pages, team import, spreadsheet reading, My Teams and the scoring page with autosave, conflicts and submission, status, the Evaluations, review, reopen and Judge progress screens, the Leaderboard and the Dashboard). No database needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `npm run test:db`   | 229 tests against the real XAMPP MySQL. 67 cover the database (migrations, constraints, triggers, rubric versioning, evaluation history, admin seed, least-privilege account, backup and restore). 29 cover sign-in (login, lockout, rate limit, password change, session expiry, logout, disabled accounts, role checks, cross-site requests, recovery). 28 cover user management (create, edit, disable, reactivate, role changes, password reset, last-admin protection including two admins acting at once, judge access refused, validation, audit log). 28 cover teams (create, edit, duplicate Team IDs, archive, search, sort, pagination, assignments and bulk assignment, disabled accounts and archived teams refused, unassigning keeps evaluations, judge visibility, import preview, confirmation, row errors and full rollback, audit log). 22 cover Rubric Management (drafts, the fixed 4 × 2 shape, weights totalling 100%, validation messages, publishing, editing after publishing, version history, evaluations protected, judge read-only access, administrators as judges, audit log, simultaneous publishes and saves). 17 cover judging (starting, drafts, server-side scoring, rating validation, stale-tab conflicts, rollback of a failed save, required ratings, submission and locking, duplicate submissions, admins as judges, archived teams, disabled accounts, unassignment, rubric versions). 15 cover evaluation review (listing and filters, read-only details, submission snapshots, throttled draft history, reopening rules and reasons, resubmission, simultaneous reopen attempts, judge progress, mixed rubric versions, admins as judges, audit consistency). 19 cover official results (averages and exact ties, full precision, recalculation from ratings, every status, reopen and resubmit, judges added and removed, archived teams, disabled judges, new rubric versions, search and sort, dashboard figures, admin-only access, invalid filters, session expiry, simultaneous submissions, no writes). 4 check the demo dataset (including checklist steps 8–10)'s documented results. They use a separate scratch database (`<DB_NAME>_test`) that is created and deleted automatically, so your data is never touched. The `server\\.env` account must be allowed to create databases (XAMPP `root` is). |
| `npm run typecheck` | TypeScript checks for all workspaces.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `npm run lint`      | ESLint.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `npm run format`    | Reformat all files with Prettier.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## 8. Troubleshooting

| Symptom                                                      | Fix                                                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `npm : … running scripts is disabled on this system`         | Use `npm.cmd` instead of `npm`, or run once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.    |
| `EBADENGINE` / "Unsupported engine" during `npm install`     | Install Node.js 24 LTS, close and reopen the terminal, check `node -v`.                                |
| `ECONNREFUSED` on `db:check` or a red database tile          | MySQL isn't running. Start it in the XAMPP Control Panel.                                              |
| `ER_ACCESS_DENIED_ERROR`                                     | Wrong `DB_USER` / `DB_PASSWORD` in `server\.env`.                                                      |
| `ER_BAD_DB_ERROR`                                            | Run `npm run db:create`.                                                                               |
| `Port 4000 is already in use` / Vite says port 5173 is taken | Close the other program (or an older `npm run dev` window), or change `PORT` in `server\.env`.         |
| XAMPP MySQL won't start (port 3306 busy)                     | Another MySQL service is running. Stop it in Windows _Services_, or change XAMPP's port and `DB_PORT`. |
| `HOST=0.0.0.0 would expose the API to the network`           | Expected safety check. Keep `HOST=127.0.0.1` until network access is set up.                           |

## 9. Project layout

```
judging-platform-local/
  package.json          npm workspaces and all scripts
  .nvmrc                Node 24
  scripts/check-node.mjs stops npm install on the wrong Node version
  eslint.config.js      lint rules
  tsconfig.base.json    shared TypeScript settings
  shared/               types and constants shared by server and client
  server/               Express 5 API (TypeScript)
    .env.example        settings template → copy to .env
    src/config.ts       validated settings; refuses to expose the API to the network
    src/db/pool.ts      MySQL connection pool and health check
    src/routes/health.ts GET /api/health
    src/app.ts          security headers, JSON limits, routes, error handling
    migrations/         numbered SQL files 001–009 (core, rubric, evaluations, auth, users, teams, rubric management, evaluation access, evaluation history)
    src/results/        official results: eligibility, ranking, leaderboard and dashboard (read-only)
    src/review/         administrator review: list, details, history, reopen, judge progress
    src/evaluations/    judge evaluations: start, save, submit (service, routes)
    src/rubric/         rubric drafts, saving, publishing (service, routes)
    src/teams/          teams, assignments and import (validation, service, routes)
    src/db/             migration runner, admin seed, backup/restore, app account
    scripts/            db:* commands (db-demo.ts + lib/demoSeed.ts build the separate demo database)
    test/               unit tests; test/db/ holds the real-database tests
  docs/phase8-results.md  results rules, demo dataset, expected results, Windows checklist
  client/               React 19 + Vite 7 + Tailwind CSS 4
    public/brand/       iSchool and Al Ahly Club logos (served locally)
    public/templates/   team import templates (.xlsx and .csv)
    src/                layout, pages (auth, users, teams, rubric, judge, evaluations, leaderboard, dashboard), star rating, API client, spreadsheet reader
    test/               UI tests
```

## 10. Security notes

- Secrets live only in `server\.env`, which is git-ignored.
- The API and Vite bind to `127.0.0.1`. The server refuses to start on another address unless
  `ALLOW_NETWORK_ACCESS=true` is set. Don't set it until HTTPS is configured.
- Keep XAMPP MySQL bound to `127.0.0.1` (the default `bind-address` in `C:\xampp\mysql\bin\my.ini`).
  Never open port 3306 in the Windows Firewall.
- `npm run db:app-user` gives the API a least-privilege MySQL account. Even if the API had a bug, the
  database refuses to delete teams or evaluations, or change the audit log. Triggers enforce the same rules for
  every account, including `root`.
- Passwords are stored only as bcrypt hashes (cost 12). Temporary passwords are shown once.
- Sessions are stored in MySQL. The browser holds only a signed, random id in an `httpOnly`,
  `SameSite=Strict` cookie. Sign-in issues a new session id, and changes from other origins are refused.
- Every API call reloads the user, so disabling an account or resetting its password takes effect on
  its very next request.
- The `backups` folder contains all competition data. It is git-ignored; keep copies somewhere safe.
