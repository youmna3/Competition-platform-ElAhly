import { Router } from 'express';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { AdminOverview, JudgeAssignment, RubricState } from '@judging/shared';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { usersRouter } from '../users/routes.js';
import { teamsRouter } from '../teams/routes.js';

/** GET /api/admin/* — administrators only. */
export function adminRouter(pool: Pool): Router {
  const router = Router();
  router.use(requireAuth, requireRole('admin'));
  router.use('/users', usersRouter(pool));
  router.use('/', teamsRouter(pool));

  router.get('/overview', async (_req, res, next) => {
    try {
      const [[row]] = (await pool.query(
        `SELECT
           (SELECT state FROM v_rubric_status) AS rubric_state,
           (SELECT published_version_no FROM v_rubric_status) AS published_version_no,
           (SELECT COUNT(*) FROM users WHERE role = 'judge' AND status = 'active') AS active_judges,
           (SELECT COUNT(*) FROM users WHERE role = 'admin' AND status = 'active') AS active_admins,
           (SELECT COUNT(*) FROM teams WHERE status = 'active') AS active_teams,
           (SELECT COUNT(*) FROM teams WHERE status = 'archived') AS archived_teams,
           (SELECT COUNT(*) FROM evaluations WHERE status = 'submitted') AS submitted_evaluations`,
      )) as unknown as [RowDataPacket[]];
      const body: AdminOverview = {
        rubricState: String(row?.rubric_state ?? 'not_configured') as RubricState,
        publishedRubricVersion:
          row?.published_version_no == null ? null : Number(row.published_version_no),
        activeJudges: Number(row?.active_judges ?? 0),
        activeAdmins: Number(row?.active_admins ?? 0),
        activeTeams: Number(row?.active_teams ?? 0),
        archivedTeams: Number(row?.archived_teams ?? 0),
        submittedEvaluations: Number(row?.submitted_evaluations ?? 0),
      };
      res.json(body);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

/** GET /api/judge/* — anyone who evaluates (judges, and admins assigned to teams). */
export function judgeRouter(pool: Pool): Router {
  const router = Router();
  router.use(requireAuth, requireRole('judge', 'admin'));

  router.get('/assignments', async (req, res, next) => {
    try {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT t.id, t.team_code, t.name, t.project_name, tj.assigned_at, e.status AS evaluation_status
         FROM team_judges tj
         JOIN teams t ON t.id = tj.team_id AND t.status = 'active'
         LEFT JOIN evaluations e ON e.team_id = t.id AND e.judge_id = tj.judge_id
         WHERE tj.judge_id = ?
         ORDER BY t.team_code`,
        [req.user!.id],
      );
      const body: JudgeAssignment[] = rows.map((r) => ({
        teamId: Number(r.id),
        teamCode: String(r.team_code),
        teamName: String(r.name),
        projectName: String(r.project_name),
        assignedAt: new Date(r.assigned_at).toISOString(),
        evaluationStatus: r.evaluation_status
          ? (r.evaluation_status as 'draft' | 'submitted')
          : 'not_started',
      }));
      res.json({ assignments: body });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
