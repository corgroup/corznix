import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { Button } from '../../../components/ui/Button.jsx';
import { FormField } from '../../../components/ui/FormField.jsx';
import { InlineAlert } from '../../../components/feedback/InlineAlert.jsx';
import { adminApi } from '../../../api/adminApi.js';
import { useMutation } from '../useMutation.js';
import { SeoPreview } from '../editor/SeoPreview.jsx';

// Search-engine listing — its own step in the create flow. seoTitle /
// seoDescription both fall back to the product name / short description on the
// storefront, so leaving them blank is fine (they're optional). Persists via
// PATCH /products/:id; in create mode the parent runs ensureDraft first.
const FIELDS = ['seoTitle', 'seoDescription', 'seoKeywords'];

export const SeoTab = forwardRef(function SeoTab({ product, canWrite, onSaved, onDirtyChange, embedded = false }, ref) {
  const base = () => Object.fromEntries(FIELDS.map((k) => [k, product?.[k] ?? '']));
  const [form, setForm] = useState(base);
  const [save, { busy, error }] = useMutation((body) => adminApi.catalog.updateProduct(product.id, body));
  const [okMsg, setOkMsg] = useState('');

  const dirty = JSON.stringify(form) !== JSON.stringify(base());
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const set = (k) => (v) => { setForm((s) => ({ ...s, [k]: v })); setOkMsg(''); };

  const doSave = async () => {
    if (!product?.id) throw new Error('Save the product first.');
    const body = {};
    for (const k of FIELDS) {
      const v = form[k].trim();
      if ((product[k] ?? '') !== v) body[k] = v === '' ? null : v;
    }
    if (Object.keys(body).length === 0) return undefined;
    const updated = await save(body);
    setOkMsg('Saved.');
    onSaved?.(updated);
    return updated;
  };

  useImperativeHandle(ref, () => ({ isDirty: dirty, save: doSave }));

  return (
    <form className="editor-form" onSubmit={(e) => { e.preventDefault(); doSave().catch(() => {}); }}>
      <div className="editor-form__grid">
        <FormField id="seoTitle" label="SEO title" value={form.seoTitle} onChange={set('seoTitle')}
          disabled={!canWrite} placeholder="Defaults to the product name" />
        <FormField id="seoDescription" label="SEO description" value={form.seoDescription} onChange={set('seoDescription')}
          disabled={!canWrite} placeholder="Defaults to the short description" />
        <FormField id="seoKeywords" label="SEO keywords" value={form.seoKeywords} onChange={set('seoKeywords')}
          disabled={!canWrite} placeholder="Comma separated, e.g. oversized tee, 240 gsm cotton"
          hint="Rendered as the product page meta keywords. Optional." />
      </div>
      <SeoPreview
        slug={product?.slug}
        title={form.seoTitle || product?.name}
        description={form.seoDescription || product?.shortDescription}
      />
      {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
      {okMsg && <InlineAlert tone="info">{okMsg}</InlineAlert>}
      {canWrite && !embedded && <Button type="submit" busy={busy} disabled={!dirty}>Save SEO</Button>}
    </form>
  );
});

export default SeoTab;
