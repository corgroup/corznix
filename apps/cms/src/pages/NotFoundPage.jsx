import { Link } from 'react-router-dom';
import { useAuth } from '../auth/useAuth.js';

export function NotFoundPage() {
  const { isAuthenticated } = useAuth();
  return (
    <div className="centered-page">
      <p className="centered-page__code">404</p>
      <h1 className="centered-page__title">Page not found</h1>
      <p className="centered-page__text">That route doesn&apos;t exist in the admin console.</p>
      <Link to={isAuthenticated ? '/' : '/login'} className="btn btn--secondary">
        {isAuthenticated ? 'Back to dashboard' : 'Go to sign in'}
      </Link>
    </div>
  );
}

export default NotFoundPage;
