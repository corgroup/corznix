export function FormField({ id, label, type = 'text', value, onChange, autoComplete, required, disabled, hint, error, className, ...rest }) {
  // `hint` and `error` are pulled out of ...rest deliberately: spreading them
  // onto <input> would emit unknown DOM attributes. Both are rendered as text
  // and wired to the input via aria-describedby so screen readers announce
  // them; an error also marks the input aria-invalid, which the shared
  // control styles show as a danger border.
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="form-field">
      <label htmlFor={id}>
        {label}
        {required && <span className="form-field__req" aria-hidden="true">*</span>}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        required={required}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
        className={['form-field__input', className].filter(Boolean).join(' ')}
      />
      {error && <p className="form-field__error" id={errorId}>{error}</p>}
      {hint && <p className="form-field__hint" id={hintId}>{hint}</p>}
    </div>
  );
}

export default FormField;
