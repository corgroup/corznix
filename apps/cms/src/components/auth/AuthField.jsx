import { useState } from 'react';
import { AuthIcon } from './AuthIcon.jsx';

// Icon-in-input field for the auth screens only (components/ui/FormField.jsx
// stays untouched — it's used across the rest of the CMS and redesigning it
// here would ripple into every other form). `type="password"` gets a
// show/hide toggle for free.
export function AuthField({ id, label, type = 'text', icon, value, onChange, autoComplete, required, disabled, placeholder }) {
  const isPassword = type === 'password';
  const [reveal, setReveal] = useState(false);
  return (
    <div className="auth-field">
      <label className="auth-field__label" htmlFor={id}>{label}</label>
      <div className="auth-field__control">
        {icon && <AuthIcon name={icon} />}
        <input
          id={id}
          name={id}
          type={isPassword && reveal ? 'text' : type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          required={required}
          disabled={disabled}
          placeholder={placeholder}
        />
        {isPassword && (
          <button
            type="button"
            className="auth-field__toggle"
            onClick={() => setReveal((v) => !v)}
            aria-label={reveal ? 'Hide password' : 'Show password'}
            tabIndex={-1}
          >
            <AuthIcon name={reveal ? 'eyeOff' : 'eye'} />
          </button>
        )}
      </div>
    </div>
  );
}

export default AuthField;
