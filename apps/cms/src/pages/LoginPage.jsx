import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/useAuth.js';
import { AuthShell } from '../components/auth/AuthShell.jsx';
import { AuthField } from '../components/auth/AuthField.jsx';
import { InlineAlert } from '../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { normalizeApiError } from '../utils/errors.js';

export function LoginPage() {
  const { loading, isAuthenticated, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const from = location.state?.from || '/';

  if (loading) return <LoadingState label="Loading…" fullscreen />;
  if (isAuthenticated) return <Navigate to={from} replace />;

  const onSubmit = async (event) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email.trim(), password);
      navigate(from, { replace: true });
    } catch (err) {
      const normalized = normalizeApiError(err);
      // The backend returns one generic failure for every bad-credential
      // reason — surface exactly that, nothing more specific.
      setError(
        normalized.kind === 'rateLimit'
          ? normalized.message
          : 'Invalid email or password.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      eyebrow="Admin Console"
      icon="shieldLock"
      heading="Staff sign in"
      hint="Use your staff account. Customer logins do not work here."
    >
      <form onSubmit={onSubmit} className="auth-shell__form" noValidate>
        <AuthField
          id="email"
          label="Email"
          type="email"
          icon="mail"
          placeholder="Enter your email address"
          value={email}
          onChange={setEmail}
          autoComplete="username"
          required
          disabled={busy}
        />
        <AuthField
          id="password"
          label="Password"
          type="password"
          icon="lock"
          placeholder="Enter your password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          required
          disabled={busy}
        />
        <InlineAlert tone="error">{error}</InlineAlert>
        <button type="submit" className="auth-btn" disabled={busy || !email || !password} aria-busy={busy || undefined}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </AuthShell>
  );
}

export default LoginPage;
