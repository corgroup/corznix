import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { Button } from '../../../components/ui/Button.jsx';
import { Select } from '../../../components/ui/Select.jsx';
import { InlineAlert } from '../../../components/feedback/InlineAlert.jsx';
import { adminApi } from '../../../api/adminApi.js';
import { useMutation } from '../useMutation.js';

// Explicit assignment only — never inferred from the product name or
// category (Wave 8B §39/§107). Creating/editing guides is a later wave.
export const SizeGuideTab = forwardRef(function SizeGuideTab({ product, canWrite, onSaved, onDirtyChange, embedded = false }, ref) {
  const [guides, setGuides] = useState([]);
  const [selected, setSelected] = useState(product?.sizeGuide?.id ?? null);
  const [assign, { busy, error }] = useMutation((id) => adminApi.catalog.assignSizeGuide(product.id, id));
  const [okMsg, setOkMsg] = useState('');

  useEffect(() => { adminApi.catalog.sizeGuides().then((d) => setGuides(d.sizeGuides), () => {}); }, []);

  const dirty = (selected ?? null) !== (product?.sizeGuide?.id ?? null);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const doSave = async () => {
    if (!dirty) return undefined;
    const updated = await assign(selected ?? null);
    setOkMsg(selected ? 'Size guide assigned.' : 'Size guide cleared.');
    onSaved(updated);
    return updated;
  };
  useImperativeHandle(ref, () => ({ isDirty: dirty, save: doSave }));

  return (
    <div className="tab-body">
      <p className="tab-body__hint">Pick a reusable size guide. This mapping is used by the storefront PDP.</p>
      <div className="editor-form__grid">
        <Select
          id="size-guide"
          label="Assigned size guide"
          value={selected}
          onChange={(v) => { setSelected(v); setOkMsg(''); }}
          options={guides.map((g) => [g.id, `${g.name}${g.unit ? ` (${g.unit})` : ''}`])}
          includeBlank
          blankLabel="— None —"
          disabled={!canWrite}
        />
      </div>
      {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
      {okMsg && <InlineAlert tone="info">{okMsg}</InlineAlert>}
      {canWrite && !embedded && (
        <Button busy={busy} disabled={!dirty} onClick={doSave}>Save</Button>
      )}
    </div>
  );
});

export default SizeGuideTab;
