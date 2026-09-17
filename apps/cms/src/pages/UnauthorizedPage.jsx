import { Link } from 'react-router-dom';

export function UnauthorizedPage({ requiredPermission }) {
  return (
    <div className="centered-page">
      <p className="centered-page__code">403</p>
      <h1 className="centered-page__title">Not authorized</h1>
      <p className="centered-page__text">
        Your role doesn&apos;t include the access needed for this area
        {requiredPermission ? <> (<code>{requiredPermission}</code>)</> : null}.
        Ask a Super Admin if you think this is wrong.
      </p>
      <Link to="/" className="btn btn--secondary">Back to dashboard</Link>
    </div>
  );
}

export default UnauthorizedPage;
