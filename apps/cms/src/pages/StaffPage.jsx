import { PageShell } from '../layout/PageShell.jsx';
import { adminApi } from '../api/adminApi.js';
import { useApiResource } from '../hooks/useApiResource.js';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';

function roleLabel(role) {
  return String(role || '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

export function StaffPage() {
  const { status, data, error, reload } = useApiResource(() => adminApi.listStaff());
  const staff = data?.staff ?? [];

  return (
    <PageShell
      title="Staff / Access"
      description="Read-only roster. New staff are created via the server bootstrap command; management UI arrives in a later wave."
    >
      {status === 'loading' && <LoadingState label="Loading staff…" />}
      {status === 'error' && <ErrorState message={error?.message} onRetry={reload} />}
      {status === 'ready' && (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last login</th>
              </tr>
            </thead>
            <tbody>
              {staff.map((member) => (
                <tr key={member.id}>
                  <td>{member.firstName} {member.lastName}</td>
                  <td>{member.email}</td>
                  <td>{roleLabel(member.role)}</td>
                  <td>
                    <span className={`pill pill--${member.status === 'ACTIVE' ? 'good' : 'muted'}`}>
                      {member.status}
                    </span>
                  </td>
                  <td>{formatDate(member.lastLoginAt)}</td>
                </tr>
              ))}
              {staff.length === 0 && (
                <tr><td colSpan={5} className="data-table__empty">No staff accounts yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}

export default StaffPage;
