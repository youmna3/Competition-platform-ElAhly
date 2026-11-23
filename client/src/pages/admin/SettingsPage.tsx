import { CompetitionSettings } from './CompetitionSettings';
import { Link } from 'react-router';
import { Card } from '../../components/ui';

export function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <p className="eyebrow">Administration</p>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="mt-1 text-sm text-muted">Administrative tools for the judging platform.</p>
      </div>
      <CompetitionSettings />
      <Card>
        <h2 className="text-lg font-semibold">System health</h2>
        <p className="mt-2 mb-4 text-sm text-muted">Check application and database availability.</p>
        <Link className="secondary-link" to="/admin/settings/status">
          Open System Status
        </Link>
      </Card>
    </div>
  );
}
