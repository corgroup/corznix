// A single design-token colour control: label + native colour swatch + hex
// text input, kept in sync. Used by the theme editor.
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function ColorTokenField({ label, value, onChange, disabled }) {
  const valid = HEX_RE.test(String(value || '').trim());
  const forPicker = valid ? value : '#000000';
  const id = `tok-${label.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <div className="color-token-field">
      <label className="color-token-field__label" htmlFor={id}>{label}</label>
      <input
        type="color"
        className="color-token-field__swatch"
        value={forPicker}
        disabled={disabled}
        aria-label={`${label} colour picker`}
        onChange={(e) => onChange(e.target.value)}
      />
      <input
        id={id}
        className="rows-editor__input"
        type="text"
        value={value ?? ''}
        placeholder="#000000"
        disabled={disabled}
        aria-invalid={value && !valid ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export default ColorTokenField;
