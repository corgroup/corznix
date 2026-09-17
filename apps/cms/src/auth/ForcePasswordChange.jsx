import { useState } from 'react';
import { AuthShell } from '../components/auth/AuthShell.jsx';
import { AuthField } from '../components/auth/AuthField.jsx';
import { AuthIcon } from '../components/auth/AuthIcon.jsx';
import { InlineAlert } from '../components/feedback/InlineAlert.jsx';
import { normalizeApiError } from '../utils/errors.js';
import { useAuth } from './useAuth.js';

// Shown by RequireStaff when the signed-in staff account still has a temporary
// password (must_change_password). The backend refuses every feature route
// until this succeeds; on success the session is rotated and the shell loads.
const MIN_LEN = 12;

export function ForcePasswordChange() {
  const { staff, changePassword, logout } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const tooShort = next.length > 0 && next.length < MIN_LEN;
  const mismatch = confirm.length > 0 && next !== confirm;
  const sameAsCurrent = next.length > 0 && next === current;
  const canSubmit = current && next.length >= MIN_LEN && next === confirm && !sameAsCurrent && !busy;

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    try {
      await changePassword(current, next);
      // success → useAuth().mustChangePassword flips false → RequireStaff renders the shell
    } catch (err) {
      setError(normalizeApiError(err).message || 'Could not change your password.');
      setBusy(false);
    }
  };

  return (
    <AuthShell
      eyebrow="Set a new password"
      icon="key"
      heading="Choose your password"
      hint={
        <>
          Your account was created with a temporary password{staff?.email ? ` for ${staff.email}` : ''}. Set your own
          password to continue — it must be at least {MIN_LEN} characters.
        </>
      }
    >
      <form onSubmit={onSubmit} className="auth-shell__form" noValidate>
        <AuthField id="fpc-current" label="Temporary password" type="password" icon="lock" value={current}
          onChange={setCurrent} autoComplete="current-password" required disabled={busy} />
        <AuthField id="fpc-new" label="New password" type="password" icon="lock" value={next}
          onChange={setNext} autoComplete="new-password" required disabled={busy} />
        {tooShort && <p className="tab-body__hint" style={{ color: 'var(--danger,#c00)' }}>At least {MIN_LEN} characters.</p>}
        {sameAsCurrent && <p className="tab-body__hint" style={{ color: 'var(--danger,#c00)' }}>Choose a password different from the temporary one.</p>}
        <AuthField id="fpc-confirm" label="Confirm new password" type="password" icon="lock" value={confirm}
          onChange={setConfirm} autoComplete="new-password" required disabled={busy} />
        {mismatch && <p className="tab-body__hint" style={{ color: 'var(--danger,#c00)' }}>Passwords do not match.</p>}
        {error && <InlineAlert tone="error">{error}</InlineAlert>}
        <button type="submit" className="auth-btn" disabled={!canSubmit} aria-busy={busy || undefined}>
          {busy ? 'Working…' : 'Set password & continue'}
        </button>
      </form>
      <button type="button" className="auth-shell__footer" onClick={logout}>
        <AuthIcon name="logout" />
        Sign out instead
      </button>
    </AuthShell>
  );
}

export default ForcePasswordChange;
