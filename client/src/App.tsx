import { Route, Routes } from 'react-router';
import { AppLayout } from './components/AppLayout';
import { HomeRedirect, RequireAuth } from './auth/RequireAuth';
import { LoginPage } from './pages/auth/LoginPage';
import { ChangePasswordPage } from './pages/auth/ChangePasswordPage';
import { AdminDashboardPage } from './pages/admin/AdminDashboardPage';
import { JudgeTeamsPage } from './pages/judge/JudgeTeamsPage';
import { StatusPage } from './pages/StatusPage';
import { UsersPage } from './pages/admin/users/UsersPage';
import { TeamsPage } from './pages/admin/teams/TeamsPage';
import { TeamImportPage } from './pages/admin/teams/TeamImportPage';
import { TeamDetailsPage } from './pages/admin/teams/TeamDetailsPage';
import { RubricManagementPage } from './pages/admin/rubric/RubricManagementPage';
import { ViewRubricPage } from './pages/rubric/ViewRubricPage';
import { EvaluationPage } from './pages/judge/EvaluationPage';
import { EvaluationsPage } from './pages/admin/evaluations/EvaluationsPage';
import { JudgeProgressPage } from './pages/admin/evaluations/JudgeProgressPage';
import { EvaluationReviewPage } from './pages/admin/evaluations/EvaluationReviewPage';
import { LeaderboardPage } from './pages/admin/results/LeaderboardPage';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route path="/change-password" element={<ChangePasswordPage />} />
        <Route
          path="/admin"
          element={
            <RequireAuth roles={['admin']}>
              <AdminDashboardPage />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/users"
          element={
            <RequireAuth roles={['admin']}>
              <UsersPage />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/teams"
          element={
            <RequireAuth roles={['admin']}>
              <TeamsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/teams/import"
          element={
            <RequireAuth roles={['admin']}>
              <TeamImportPage />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/teams/:id"
          element={
            <RequireAuth roles={['admin']}>
              <TeamDetailsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/evaluations"
          element={
            <RequireAuth roles={['admin']}>
              <EvaluationsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/evaluations/progress"
          element={
            <RequireAuth roles={['admin']}>
              <JudgeProgressPage />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/evaluations/:id"
          element={
            <RequireAuth roles={['admin']}>
              <EvaluationReviewPage />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/leaderboard"
          element={
            <RequireAuth roles={['admin']}>
              <LeaderboardPage />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/rubric"
          element={
            <RequireAuth roles={['admin']}>
              <RubricManagementPage />
            </RequireAuth>
          }
        />
        <Route
          path="/rubric"
          element={
            <RequireAuth roles={['judge', 'admin']}>
              <ViewRubricPage />
            </RequireAuth>
          }
        />
        <Route
          path="/admin/status"
          element={
            <RequireAuth roles={['admin']}>
              <StatusPage />
            </RequireAuth>
          }
        />
        <Route
          path="/judge/teams/:teamId"
          element={
            <RequireAuth roles={['judge', 'admin']}>
              <EvaluationPage />
            </RequireAuth>
          }
        />
        <Route
          path="/judge"
          element={
            <RequireAuth roles={['judge', 'admin']}>
              <JudgeTeamsPage />
            </RequireAuth>
          }
        />
      </Route>
      <Route path="*" element={<HomeRedirect />} />
    </Routes>
  );
}
