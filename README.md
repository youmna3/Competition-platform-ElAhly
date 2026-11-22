# iSchool × Al Ahly Judging Platform

A local, offline judging platform for the iSchool × Al Ahly Club competition. It runs on one Windows
computer with Node.js 24 LTS and XAMPP MySQL. No cloud services, CDNs or external accounts are used.

**Status: Phase 4 (teams and judge assignments) is complete.** Administrators manage teams on the
**Teams** page: add, edit, archive and reactivate them, import many at once from Excel or CSV, and
assign judges to one team or to many teams at once. Judges see their assigned teams under **My
assigned teams**. Scoring opens in Phase 6. Teams are never deleted, only archived, and every change
is recorded in the audit log. The rubric remains **Not configured** until Rubric Management (Phase 5).

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

| Command                                  | What it does                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `npm run db:setup`                       | Create the database if needed, apply migrations, create the first admin. Safe to repeat.                   |
| `npm run db:migrate`                     | Apply new migrations only. `npm run db:migrate -- --status` lists them.                                    |
| `npm run db:seed`                        | Create the first admin only (if missing).                                                                  |
| `npm run db:app-user`                    | Create or refresh the least-privilege `judging_app` MySQL account.                                         |
| `npm run auth:secret`                    | Add a random `SESSION_SECRET` to `server\.env` if it doesn't have one.                                     |
| `npm run auth:reset-password -- [email]` | Account recovery: new temporary password shown once, all sessions ended, lockout cleared.                  |
| `npm run db:check`                       | Test the connection with the API's settings.                                                               |
| `npm run db:reset -- --yes`              | **Development only:** delete everything and rebuild an empty database. Refused when `NODE_ENV=production`. |

## 7. Tests and checks

| Command             | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run check`     | Type checking, lint, formatting check and all unit tests. Run before every commit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `npm test`          | Unit tests: 19 server tests and 40 UI tests (sign-in, route guards, password change, Users and Teams pages, team import, spreadsheet reading, judge team list, status). No database needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `npm run test:db`   | 150 tests against the real XAMPP MySQL. 65 cover the database (migrations, constraints, triggers, rubric versioning, evaluation history, admin seed, least-privilege account, backup and restore). 29 cover sign-in (login, lockout, rate limit, password change, session expiry, logout, disabled accounts, role checks, cross-site requests, recovery). 28 cover user management (create, edit, disable, reactivate, role changes, password reset, last-admin protection including two admins acting at once, judge access refused, validation, audit log). 28 cover teams (create, edit, duplicate Team IDs, archive, search, sort, pagination, assignments and bulk assignment, disabled accounts and archived teams refused, unassigning keeps evaluations, judge visibility, import preview, confirmation, row errors and full rollback, audit log). They use a separate scratch database (`<DB_NAME>_test`) that is created and deleted automatically, so your data is never touched. The `server\\.env` account must be allowed to create databases (XAMPP `root` is). |
| `npm run typecheck` | TypeScript checks for all workspaces.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `npm run lint`      | ESLint.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `npm run format`    | Reformat all files with Prettier.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

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
    migrations/         numbered SQL files 001–006 (core, rubric, evaluations, auth, users, teams)
    src/teams/          teams, assignments and import (validation, service, routes)
    src/db/             migration runner, admin seed, backup/restore, app account
    scripts/            db:* commands
    test/               unit tests; test/db/ holds the real-database tests
  client/               React 19 + Vite 7 + Tailwind CSS 4
    public/brand/       iSchool and Al Ahly Club logos (served locally)
    public/templates/   team import templates (.xlsx and .csv)
    src/                layout, pages (auth, users, teams, judge), API client, spreadsheet reader
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
