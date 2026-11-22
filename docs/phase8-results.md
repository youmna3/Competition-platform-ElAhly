# Phase 8: official results, leaderboard and dashboard

## 1. Rules

### Official team score

- **Official score = the arithmetic average of the submitted final scores of all judges currently
  assigned to the team.** Every judge has equal weight, administrators assigned as judges included.
- Each judge's score is **recomputed on the server** from the stored star ratings and the section
  weights of the rubric version that evaluation used. The stored total is only a cross-check: if they
  disagree, the team is **Blocked** ("stored score does not match the ratings").
- Full precision is kept. Scores are rounded to 2 decimals **only for display**.
- Excluded: drafts, reopened evaluations (until resubmitted), evaluations by judges who are no longer
  assigned (kept as history), and archived teams.
- Results are read-only. Nothing in Phase 8 writes scores. There is no API to edit a score.

### Eligibility (when a team is officially ranked)

A team is ranked only when all of these are true:

1. the team is active;
2. at least one judge is assigned;
3. every assigned judge has submitted;
4. no evaluation is reopened;
5. all submitted evaluations use the same rubric version;
6. nothing blocks it (no disabled assigned judge, no score mismatch).

### Statuses

| Status            | Meaning                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| Unassigned        | No judges assigned.                                                                                                |
| Not started       | Judges assigned, none has started.                                                                                 |
| In progress       | At least one started; not everyone has submitted (includes reopened evaluations).                                  |
| Ready for results | Eligible: ranked.                                                                                                  |
| Blocked           | Needs an administrator: an assigned judge is disabled, judges used different rubric versions, or a score mismatch. |

A disabled assigned judge always blocks the team. They are never silently left out, because that
would change the average without anyone deciding it. Fix: reactivate the account, or remove the
assignment (their evaluation then stops counting).

### Ranking

- Competition ranking: equal scores share a rank and the next rank is skipped (1, 1, 3).
- "Equal" means **exactly equal unrounded averages**. Averages are compared exactly, as integer
  fractions (scores are stored to 3 decimals), so floating-point rounding can never create or hide a
  tie. 80.333… and 80.3285 both display as 80.33 but are ranked 1 and 2.
- No tie-break by submission time, name or anything else. Among tied teams, the display order is by
  Team ID only so the list doesn't jump around.

### Rubric versions

- If ready teams were scored with **different rubric versions**, there is **no official ranking**. The
  Leaderboard says which teams use which version and shows a separate, clearly labelled
  **provisional comparison per version**.
- A team whose own judges submitted on different versions is **Blocked**.
- Warnings appear when unranked teams have evaluations on another version, and when the ranking's
  version is no longer the published one.
- Nothing is converted, migrated or rescored automatically. To fix a mix, reopen the older
  evaluations. Each judge resumes on the version they started with, so the administrator decides
  how to bring the team onto one version (for example, by agreeing to keep the published rubric
  unchanged during judging).

## 2. What changed

- **No database changes.** No migration, no new tables, no new permissions. Results are calculated
  from existing data in one consistent read (a consistent snapshot), so a submission arriving at the
  same moment is either fully counted or not at all.
- API (administrators only, read-only):
  - `GET /api/admin/results?search=&sort=rank|teamCode|name|projectName|judges|submitted&dir=asc|desc`.
    Unknown parameters or values are refused with `400 VALIDATION_ERROR`.
  - `GET /api/admin/dashboard`.
  - `GET /api/admin/overview` (rubric state) is unchanged.
- Pages: **Leaderboard** (`/admin/leaderboard`) and the new **Dashboard** figures and charts.
- Tools: `npm run db:demo` and `npm run demo:dev` (separate demo database).

## 3. Demo dataset (`npm run db:demo`)

Creates `<DB_NAME>_demo` only. All accounts share the password printed by the command (also in
`server\.env.demo` as `DEMO_LOGIN_PASSWORD`).

| Account               | Role          | Notes                              |
| --------------------- | ------------- | ---------------------------------- |
| demo.admin@demo.local | Administrator | Also judges team D-03              |
| amina@demo.local      | Judge         |                                    |
| bassem@demo.local     | Judge         |                                    |
| carla@demo.local      | Judge         |                                    |
| dina@demo.local       | Judge         | **Disabled** after submitting      |
| emad@demo.local       | Judge         | Removed from D-05 after submitting |

Rubric **v1** weights 30 / 30 / 20 / 20 (used for almost everything). Rubric **v2** (25 / 25 / 25 / 25)
was published at the end and is the current one.

### Expected official ranking (rubric v1)

| Rank | Team | Name    | Judges and scores                                     | Final        |
| ---- | ---- | ------- | ----------------------------------------------------- | ------------ |
| 1    | D-03 | Lions   | Demo Admin 92 (admin as judge)                        | 92.00        |
| 2    | D-04 | Hawks   | Amina 80, Bassem 81, Carla 80 → 80.333…               | 80.33        |
| 3    | D-01 | Falcons | Amina 90, Bassem 80, Carla 70                         | 80.00 (tied) |
| 3    | D-02 | Eagles  | Amina 100, Bassem 60                                  | 80.00 (tied) |
| 5    | D-05 | Sharks  | Bassem 70 (Emad's 100 is excluded: he was unassigned) | 70.00        |

Two warnings are shown: D-11 has evaluations on another rubric version, and the ranking uses v1
while v2 is now published.

### Expected "Not ranked yet"

| Team | Name   | Status      | Provisional | Reason shown                                                                               |
| ---- | ------ | ----------- | ----------- | ------------------------------------------------------------------------------------------ |
| D-06 | Tigers | In progress | 80.00       | 1 of 2 judges submitted. Waiting for Carla Judge.                                          |
| D-07 | Wolves | In progress | 70.00       | 1 of 2 judges submitted. Reopened for Amina Judge: waiting for resubmission.               |
| D-08 | Bears  | Not started | —           | 0 of 1 judge submitted. Waiting for Carla Judge.                                           |
| D-09 | Owls   | Unassigned  | —           | No judges are assigned to this team.                                                       |
| D-10 | Foxes  | Blocked     | 85.00       | Dina Judge is assigned but disabled…                                                       |
| D-11 | Cobras | Blocked     | 80.00       | Judges used different rubric versions (v1, v2)…                                            |
| D-12 | Ravens | In progress | 90.00       | 1 of 2 judges submitted. Waiting for Carla Judge. (Carla was added after Amina submitted.) |

D-13 Pandas is **archived** and appears nowhere (its submitted 100 is kept but not counted).

### Expected dashboard

- Active teams **12**, 1 archived. Judges **4** (active judge accounts), "5 assigned to teams (incl.
  admins)". Administrators **1**.
- Completion **81%**: 17 of 21 evaluations submitted. Drafts **2**, 2 not started.
- Teams ready **5**, 2 blocked, 4 waiting. Judges with pending work **2**, 4 evaluations pending.
- Average submitted score **80.76** (descriptive only).
- Charts: submitted 17 / draft 2 / not started 2; ready 5 / in progress 3 / not started 1 / blocked 2 /
  unassigned 1. Judge progress: Carla 2/5, Amina 7/8, Bassem 6/6, Demo Admin 1/1, Dina (disabled) 1/1.
- Top teams: #1 Lions 92.00, #2 Hawks 80.33, #3 Falcons 80.00, #3 Eagles 80.00.

These values are checked automatically by `server/test/db/demoSeed.db.test.ts`.

## 4. Windows manual checklist

Run in the project folder in PowerShell. Stop any running `npm run dev` first. The steps change
**only the demo database**; run `npm run db:demo` again at any time to reset it.

1. `npm run db:demo`. Expect `OK  matches the documented expected results` and the accounts box.
   Write down the password.
2. `npm run demo:dev`. Expect `*** DEMO MODE: using the demo database "…_demo" ***`.
3. Open <http://127.0.0.1:5173> and sign in as `demo.admin@demo.local`.
4. **System status**: the database name ends in `_demo`.
5. **Dashboard**: check every figure in _Expected dashboard_ above.
6. **Leaderboard**: the official table matches _Expected official ranking_. D-01 and D-02 both show
   rank 3 with a _Tied_ badge; the next rank is 5. The two rubric warnings show. The _Not ranked yet_
   cards match the table above.
7. Search `solar`: only D-02 Eagles, still rank 3. Clear the search. Click the **Team** header: the
   order becomes alphabetical but the ranks don't change.
8. **Reopen and resubmit:** sign out, sign in as `amina@demo.local`, open **My teams**, open D-07 (it
   shows the reopen notice), set all ratings to 5 stars, submit. Sign in as the admin again →
   Leaderboard: D-07 is ranked **#2 with 85.00**; D-04 is #3 (80.33), D-01 and D-02 #4 (tied), D-05 #6.
9. **Disabled judge:** Users → reactivate **Dina Judge** → Leaderboard: D-10 Foxes is ranked with
   **85.00**, **tied #2 with D-07** (ranks: D-03 1, D-07 2, D-10 2, D-04 4, D-01 5, D-02 5, D-05 7).
   Disable her again: D-10 is Blocked again and the ranking returns to step 8.
10. **Remove a judge:** Teams → D-12 Ravens → remove Carla → Leaderboard: D-12 is ranked **#2 with
    90.00** (D-03 1, D-12 2, D-07 3, D-04 4, D-01 5, D-02 5, D-05 7). Assign Carla to D-12 again: it
    goes back to In progress, waiting for Carla.
11. **Archive:** Teams → archive D-05 Sharks → it disappears from the Leaderboard and the dashboard says
    11 active, 2 archived. Reactivate it → back at #6 with 70.00.
12. **Mixed versions across teams:** sign in as `carla@demo.local`, open D-08 Bears (it uses the
    current rubric, v2), give every criterion 4 stars, submit. As the admin, the Leaderboard now says
    **No official ranking yet** and lists _v1: … ; v2: D-08_. Two provisional tables appear: v1 (the
    previous ranking) and v2 (D-08, rank 1, 80.00). The Dashboard's _Top teams_ shows the same reason
    instead of teams.
13. **Admin only:** while signed in as a judge, open <http://127.0.0.1:5173/admin/leaderboard>: you are
    sent to My teams, and there is no Leaderboard menu item.
14. **Refresh:** keep the Leaderboard open in one window and submit an evaluation in another (signed
    in as a judge in a private window). The Leaderboard updates within 30 seconds, or straight away
    with **Refresh**.
15. Press Ctrl+C. Start the normal app with `npm run dev`; System status shows your real database
    again.

To remove the demo completely: in phpMyAdmin drop the `…_demo` database and the `judging_demo` user,
then delete `server\.env.demo`.

## 5. Decisions and limitations

- A disabled assigned judge **blocks** the team rather than being excluded (the spec asked for it to be
  flagged; excluding it would silently change the score).
- A team whose judges used different rubric versions is **blocked**, even though the average could be
  computed: those scores are not comparable.
- When ready teams span versions, the whole official ranking is withheld (not just the minority
  version), so an incomplete comparison is never presented as official.
- The ranking sort only reorders rows; ranks always come from the score.
- "Judges" on the Dashboard counts active judge accounts; "participating" counts everyone assigned to an
  active team, administrators included.
- No export, no public view, no tie-break rules (as specified).
