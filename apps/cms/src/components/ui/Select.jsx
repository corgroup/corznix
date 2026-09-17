export function Select({ id, label, value, onChange, options, includeBlank, blankLabel = 'All', disabled }) {
  return (
    <div className="form-field">
      {label && <label htmlFor={id}>{label}</label>}
      <select id={id} name={id} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
        {includeBlank && <option value="">{blankLabel}</option>}
        {options.map((opt) => {
          const [v, l] = Array.isArray(opt) ? opt : [opt.value, opt.label];
          return <option key={v} value={v}>{l}</option>;
        })}
      </select>
    </div>
  );
}

export default Select;
