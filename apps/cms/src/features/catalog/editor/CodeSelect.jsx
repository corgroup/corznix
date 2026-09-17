import { useState } from 'react';
import { Button } from '../../../components/ui/Button.jsx';
import { FormField } from '../../../components/ui/FormField.jsx';
import { Select } from '../../../components/ui/Select.jsx';
import { InlineAlert } from '../../../components/feedback/InlineAlert.jsx';
import { useMutation } from '../useMutation.js';

// A canonical-code picker (product type / fit) with an inline "create new"
// form. Nothing is prepopulated — the select opens on "— choose —" and the
// helper text only suggests. `onCreate(body)` calls the governed
// POST /catalog/sku/{type,fit}-codes endpoint; on success the new code is
// selected. `withFamily` adds the size-family field (type codes only).
export function CodeSelect({ id, label, hint, value, onChange, options, disabled, onCreate, withFamily = false }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ label: '', code: '', sizeFamily: 'APPAREL' });
  const [create, { busy, error }] = useMutation((body) => onCreate(body));

  return (
    <div className="code-select">
      <Select
        id={id} label={label} value={value || ''} onChange={(v) => onChange(v || '')}
        disabled={disabled} includeBlank blankLabel="— choose —"
        options={options.map((o) => [o.id, `${o.label} (${o.code})`])}
      />
      {hint && <p className="tab-body__hint">{hint}</p>}
      {!disabled && (
        adding ? (
          <form
            className="code-select__new"
            onSubmit={async (e) => {
              e.preventDefault();
              const created = await create({
                label: form.label.trim(),
                code: form.code.trim().toUpperCase(),
                ...(withFamily ? { sizeFamily: form.sizeFamily } : {}),
              });
              if (created?.id) {
                onChange(created.id);
                setAdding(false);
                setForm({ label: '', code: '', sizeFamily: 'APPAREL' });
              }
            }}
          >
            <FormField id={`${id}-label`} label="Name" value={form.label}
              onChange={(v) => setForm((s) => ({ ...s, label: v }))} placeholder="e.g. Relaxed Fit" />
            <FormField id={`${id}-code`} label="Short code" value={form.code}
              onChange={(v) => setForm((s) => ({ ...s, code: v.toUpperCase() }))} placeholder="e.g. RLX" />
            {withFamily && (
              <Select id={`${id}-fam`} label="Size family" value={form.sizeFamily}
                onChange={(v) => setForm((s) => ({ ...s, sizeFamily: v }))}
                options={[['APPAREL', 'Apparel (XS–XXXL)'], ['JEANS', 'Jeans (28–36)']]} />
            )}
            {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
            <div className="inline-editor__actions">
              <Button type="submit" busy={busy} disabled={!form.label.trim() || !form.code.trim()}>Create</Button>
              <Button type="button" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            </div>
          </form>
        ) : (
          <button type="button" className="linkish" onClick={() => setAdding(true)}>+ New {label.toLowerCase()}</button>
        )
      )}
    </div>
  );
}

export default CodeSelect;
