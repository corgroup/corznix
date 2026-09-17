import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { Button } from '../../../components/ui/Button.jsx';
import { InlineAlert } from '../../../components/feedback/InlineAlert.jsx';
import { adminApi } from '../../../api/adminApi.js';
import { useMutation } from '../useMutation.js';

// Product <-> category is an explicit M2M mapping (Wave 8D). One category is
// the primary (mirrors the storefront's category filter). Only ACTIVE
// categories are assignable.
export const CategoriesTab = forwardRef(function CategoriesTab({ product, canWrite, onSaved, onDirtyChange, embedded = false }, ref) {
  const [all, setAll] = useState([]);
  const initial = (product?.categories || []).map((c) => ({ id: c.id, isPrimary: c.isPrimary }));
  const [selected, setSelected] = useState(initial);
  const [save, { busy, error }] = useMutation((categories) => adminApi.catalog.setProductCategories(product.id, categories));
  const [okMsg, setOkMsg] = useState('');

  useEffect(() => { adminApi.catalog.categories().then((d) => setAll(d.categories.filter((c) => c.status === 'ACTIVE')), () => {}); }, []);

  const ids = selected.map((s) => s.id);
  const primaryId = selected.find((s) => s.isPrimary)?.id ?? ids[0] ?? null;
  const dirty = JSON.stringify([...ids].sort()) !== JSON.stringify([...initial.map((c) => c.id)].sort())
    || primaryId !== (initial.find((c) => c.isPrimary)?.id ?? initial[0]?.id ?? null);

  const toggle = (id) => {
    setOkMsg('');
    setSelected((s) => s.some((x) => x.id === id)
      ? s.filter((x) => x.id !== id)
      : [...s, { id, isPrimary: s.length === 0 }]);
  };
  const setPrimary = (id) => { setOkMsg(''); setSelected((s) => s.map((x) => ({ ...x, isPrimary: x.id === id }))); };

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const doSave = async () => {
    if (!dirty) return undefined;
    const updated = await save(selected.map((s) => ({ categoryId: s.id, isPrimary: s.id === primaryId })));
    setOkMsg('Categories saved.');
    onSaved(updated);
    return updated;
  };
  useImperativeHandle(ref, () => ({ isDirty: dirty, save: doSave }));

  const byParent = {};
  for (const c of all) (byParent[c.parentId || 'root'] ||= []).push(c);

  return (
    <div className="tab-body">
      <p className="tab-body__hint">Assign the product to one or more categories. The primary category drives storefront category listing.</p>
      <fieldset className="editor-form__fieldset">
        <legend>Categories</legend>
        <div className="checkbox-grid">
          {all.map((c) => {
            const on = ids.includes(c.id);
            return (
              <label key={c.id}>
                <input type="checkbox" checked={on} disabled={!canWrite} onChange={() => toggle(c.id)} />
                {c.parentName ? `${c.parentName} / ` : ''}{c.name}
                {on && (
                  <button type="button" className="linkish" style={{ marginLeft: 8 }}
                    disabled={!canWrite || primaryId === c.id}
                    onClick={() => setPrimary(c.id)}>
                    {primaryId === c.id ? '★ primary' : 'set primary'}
                  </button>
                )}
              </label>
            );
          })}
          {all.length === 0 && <span className="text-faint">No active categories.</span>}
        </div>
      </fieldset>
      {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
      {okMsg && <InlineAlert tone="info">{okMsg}</InlineAlert>}
      {canWrite && !embedded && (
        <Button busy={busy} disabled={!dirty} onClick={doSave}>Save categories</Button>
      )}
    </div>
  );
});

export default CategoriesTab;
