import { Link } from 'react-router';
import { HealthPanel } from '../components/HealthPanel';

export function StatusPage() {
  return (
    <div className="space-y-8">
      <Link className="secondary-link" to="/admin/settings">
        Back to Settings
      </Link>
      <section className="space-y-4">
        <h1 className="text-2xl font-bold">System status</h1>
        <p className="text-sm text-black/60">
          Checks that the API server can reach the local XAMPP MySQL database.
        </p>
        <HealthPanel />
      </section>
    </div>
  );
}
