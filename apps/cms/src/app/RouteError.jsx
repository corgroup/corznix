import { useRouteError, useNavigate } from 'react-router-dom';
import { ErrorState } from '../components/feedback/ErrorState.jsx';

// The CMS had no error boundary of any kind: a render error anywhere in the
// admin left staff on a blank white page, mid-task, with nothing to click and
// nothing explaining what happened. On an app used to release refunds and
// dispatch orders that is an operational problem, not a cosmetic one.
//
// Mounted as a data-router `errorElement` rather than a class boundary: it
// catches loader and action failures as well as render errors, and React
// Router already carries the error for us.
export function RouteError() {
  const error = useRouteError();
  const navigate = useNavigate();

  // Kept in the console for whoever is debugging with the staff member.
  console.error('CMS route error:', error);

  // Deliberately not shown to the user: an exception message is written for
  // developers and can carry request internals. The console has the detail.
  const status = error?.status ? `${error.status}` : null;

  return (
    <div className="page">
      <ErrorState
        title={status === '404' ? 'That page could not be found' : 'This screen hit an unexpected error'}
        message={
          status === '404'
            ? 'Check the link, or go back to the dashboard.'
            : 'Nothing you were viewing has been changed. Reloading usually clears it — if it keeps happening, send this screen to engineering.'
        }
        onRetry={() => window.location.reload()}
      />
      {/* Inside a .state block so it picks up the same centring as the
          message above it rather than hanging off the left edge. */}
      <div className="state">
        <button type="button" className="linkish" onClick={() => navigate('/')}>
          Back to dashboard
        </button>
      </div>
    </div>
  );
}

export default RouteError;
