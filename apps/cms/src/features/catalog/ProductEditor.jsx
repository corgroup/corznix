import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate } from 'react-router-dom';
import { Button } from '../../components/ui/Button.jsx';
import { Badge } from '../../components/ui/Badge.jsx';
import { LoadingState } from '../../components/feedback/LoadingState.jsx';
import { ErrorState } from '../../components/feedback/ErrorState.jsx';
import { InlineAlert } from '../../components/feedback/InlineAlert.jsx';
import { Dialog } from '../../components/ui/Dialog.jsx';
import { adminApi } from '../../api/adminApi.js';
import { useAuth } from '../../auth/useAuth.js';
import { normalizeApiError } from '../../utils/errors.js';
import { titleCase, formatDateTime } from '../../utils/format.js';
import { useMutation } from './useMutation.js';
import { GeneralTab } from './tabs/GeneralTab.jsx';
import { VariantsTab } from './tabs/VariantsTab.jsx';
import { PricingTab } from './tabs/PricingTab.jsx';
import { InventoryTab } from './tabs/InventoryTab.jsx';
import { ShippingTab } from './tabs/ShippingTab.jsx';
import { SizeGuideTab } from './tabs/SizeGuideTab.jsx';
import { SeoTab } from './tabs/SeoTab.jsx';
import { MediaTab } from './tabs/MediaTab.jsx';
import { CategoriesTab } from './tabs/CategoriesTab.jsx';
import { SectionCard } from './editor/SectionCard.jsx';
import { SizeSelectionSection } from './editor/SizeSelectionSection.jsx';
import { SetupReadinessCard } from './editor/SetupReadinessCard.jsx';
import { TaxCard } from './editor/TaxCard.jsx';
import { UnsavedChangesDialog } from './editor/UnsavedChangesDialog.jsx';
import { StepNav } from './editor/StepNav.jsx';
import { QuickOverview } from './editor/QuickOverview.jsx';
import { useDirtyRegistry } from './editor/useDirtyRegistry.js';
import './ProductEditor.css';

const NEXT_STATUS = { DRAFT: 'ACTIVE', ACTIVE: 'ARCHIVED', ARCHIVED: 'ACTIVE' };
const STATUS_ACTION = { DRAFT: 'Publish', ACTIVE: 'Archive', ARCHIVED: 'Restore' };
const STORE_ORIGIN = (import.meta.env.VITE_STOREFRONT_URL || '').replace(/\/$/, '');

// Sections holding a pending form that the top-level save orchestrates.
// Order matters — `flushDirtySections` saves in this order (Basic first so a
// draft exists, SEO/pricing after the product + SKUs).
const SAVEABLE = [
  { key: 'general', label: 'Basic information' },
  { key: 'categories', label: 'Category' },
  { key: 'sizeGuide', label: 'Size guide' },
  { key: 'pricing', label: 'Pricing' },
  { key: 'shipping', label: 'Shipping' },
  { key: 'seo', label: 'SEO' },
];
const LABELS = Object.fromEntries(SAVEABLE.map((s) => [s.key, s.label]));

// 10-step stepper (matches the create-flow reference). Each maps to exactly one
// section id; clicking a step just scrolls — nothing is gated. Every step is a
// real, backend-connected section: nothing here is display-only.
const STEP_DEFS = [
  { key: 'basic', label: 'Basic information', sections: ['section-basic'] },
  { key: 'media', label: 'Media', sections: ['section-media'] },
  { key: 'category', label: 'Category', sections: ['section-category'] },
  { key: 'sizes', label: 'Size selection', sections: ['section-sizes'] },
  { key: 'variants', label: 'Variant & SKU', sections: ['section-variants'] },
  { key: 'pricing', label: 'Pricing', sections: ['section-pricing'] },
  { key: 'shipping', label: 'Shipping', sections: ['section-shipping'] },
  { key: 'inventory', label: 'Inventory', sections: ['section-inventory'] },
  { key: 'seo', label: 'SEO', sections: ['section-seo'] },
  { key: 'setup', label: 'Setup', sections: ['section-setup'] },
];

function jumpTo(sectionId) {
  document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function LockedSection({ label, onUnlock, busy }) {
  return (
    <div className="locked-section">
      <p>Enter the product name and type above, then unlock {label.toLowerCase()}.</p>
      <Button variant="secondary" busy={busy} onClick={onUnlock}>Save &amp; continue</Button>
    </div>
  );
}

export function ProductEditor({ productId = null }) {
  const isCreate = !productId;
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canWrite = hasPermission('catalog.write');
  const canManageTax = hasPermission('tax.manage');

  const [state, setState] = useState(
    isCreate
      ? { status: 'ready', product: null, error: null }
      : { status: 'loading', product: null, error: null },
  );
  const [reloadNonce, setReloadNonce] = useState(0);
  const [revertNonce, setRevertNonce] = useState(0);
  const [basic, setBasic] = useState({});
  const [offeredSizes, setOfferedSizes] = useState([]); // Size-selection pre-pick; feeds VariantsTab
  const [activeSection, setActiveSection] = useState('section-basic');
  const { dirtyKeys, report, reset: resetDirty } = useDirtyRegistry();

  const generalRef = useRef(null);
  const categoriesRef = useRef(null);
  const shippingRef = useRef(null);
  const sizeGuideRef = useRef(null);
  const pricingRef = useRef(null);
  const seoRef = useRef(null);
  const savedRef = useRef(false); // suppress the leave-guard right after a deliberate save/publish
  const pidRef = useRef(productId); // current product id (create flow fills this after ensureDraft)

  const product = state.product;
  useEffect(() => { if (product?.id) pidRef.current = product.id; }, [product?.id]);
  const hasBasics = Boolean((product?.name || basic.name) && (product?.productType || basic.productType));
  const isDirty = dirtyKeys.length > 0 || (isCreate && !product && hasBasics);

  // ---- load (edit only) ------------------------------------------------
  useEffect(() => {
    if (isCreate) return undefined;
    let cancelled = false;
    Promise.resolve()
      .then(() => adminApi.catalog.getProduct(productId))
      .then(
        (p) => { if (!cancelled) setState({ status: 'ready', product: p, error: null }); },
        (err) => { if (!cancelled) setState({ status: 'error', product: null, error: normalizeApiError(err) }); },
      );
    return () => { cancelled = true; };
  }, [isCreate, productId, reloadNonce]);

  // ---- scroll-spy for the step navigator ------------------------------
  useEffect(() => {
    if (state.status !== 'ready') return undefined;
    const ids = STEP_DEFS.flatMap((s) => s.sections);
    const els = ids.map((id) => document.getElementById(id)).filter(Boolean);
    if (!els.length) return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.target.offsetTop - b.target.offsetTop);
        if (visible[0]) setActiveSection(visible[0].target.id);
      },
      { rootMargin: '-96px 0px -55% 0px', threshold: 0 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [state.status, product, revertNonce]);

  const onSaved = useCallback((updated) => {
    if (updated && updated.id) { setState({ status: 'ready', product: updated, error: null }); return; }
    // A section saved but didn't return the full aggregate — refetch it. Works
    // in create mode too (the load effect there is disabled).
    const id = pidRef.current;
    if (!id) { setReloadNonce((n) => n + 1); return; }
    adminApi.catalog.getProduct(id).then(
      (p) => setState({ status: 'ready', product: p, error: null }),
      () => {},
    );
  }, []);

  // ---- ensureDraft: lazily persist the create form ---------------------
  const [ensuring, setEnsuring] = useState(false);
  const ensureDraft = useCallback(async () => {
    if (state.product) return state.product;
    setEnsuring(true);
    try {
      const created = await generalRef.current?.save(); // GeneralTab POSTs /products in create mode
      if (!created?.id) throw new Error('Add a product name and product type first.');
      setState({ status: 'ready', product: created, error: null });
      return created;
    } finally {
      setEnsuring(false);
    }
  }, [state.product]);

  // ---- top-level save orchestration -----------------------------------
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const flushDirtySections = useCallback(async () => {
    const byKey = {
      general: generalRef, categories: categoriesRef, sizeGuide: sizeGuideRef,
      pricing: pricingRef, shipping: shippingRef, seo: seoRef,
    };
    for (const { key, label } of SAVEABLE) {
      const h = byKey[key].current;
      if (h?.isDirty) {
        try { await h.save(); }
        catch (err) { throw new Error(`${label}: ${err?.message || normalizeApiError(err).message}`, { cause: err }); }
      }
    }
  }, []);

  // Guards a second save while the first is still in flight. `saving` drives
  // the button's disabled state, but a double-click can land both handlers
  // before React re-renders — this ref closes that window, so no duplicate
  // request is ever issued.
  const savingRef = useRef(false);

  const runSave = useCallback(async (kind) => {
    if (savingRef.current) return null;
    savingRef.current = true;
    setSaving(true);
    setSaveError('');
    try {
      const p = await ensureDraft();
      await flushDirtySections();

      // Only a completed save navigates. A failure falls through to the catch
      // below, which keeps the operator on the editor with their work intact
      // and the reason on screen. 'publish' is excluded — its own handler
      // decides where to go once the status change succeeds.
      if (!isCreate && kind === 'changes') {
        // Editing an existing product is a finished job: close the editor and
        // return to the list, which refetches on mount so the change is
        // visible immediately.
        savedRef.current = true;
        navigate('/products');
      } else if (isCreate && kind === 'draft') {
        // Create flow, unchanged. The first save only creates the draft —
        // variants, SKUs, media and stock still have to be added — so the
        // editor stays open, now on the real id. Returning to the list here
        // would abandon a half-built product.
        //
        // `runSave('changes')` during creation deliberately does NOT navigate:
        // it is a mid-build save, and remounting the editor would throw away
        // the pre-picked sizes and the operator's place on the form.
        savedRef.current = true;
        navigate(`/products/${p.id}`);
      }
      return p;
    } catch (err) {
      setSaveError(err?.message || normalizeApiError(err).message);
      return null;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [ensureDraft, flushDirtySections, navigate, isCreate]);

  // ---- publish -------------------------------------------------------
  const [changeStatus, { busy: statusBusy, error: statusError }] = useMutation(
    (id, next) => adminApi.catalog.setStatus(id, next),
  );
  const [publishGate, setPublishGate] = useState(null); // { product, incomplete: [{label, section}] }

  const incompleteItemsFor = (p) => {
    const skuCount = (p.variants || []).reduce((n, v) => n + (v.skus?.length || 0), 0);
    const items = [];
    if (skuCount === 0) items.push({ label: 'Add at least one colour + size (SKU)', section: 'section-variants' });
    if (!p.shipping?.rateReady) items.push({ label: 'Add a shipping weight', section: 'section-shipping' });
    if (!p.taxProfile) items.push({ label: 'Assign a tax profile (needed for invoicing)', section: 'section-tax' });
    if (!(p.media || []).length) items.push({ label: 'Add at least one product image', section: 'section-media' });
    return items;
  };

  const doPublish = useCallback(async (p) => {
    await changeStatus(p.id, 'ACTIVE');
    savedRef.current = true;
    navigate(`/products/${p.id}`);
  }, [changeStatus, navigate]);

  const handlePublish = useCallback(async () => {
    const p = await runSave('publish');
    if (!p) return;
    // Re-read so readiness reflects everything just flushed.
    let fresh = p;
    try { fresh = await adminApi.catalog.getProduct(p.id); setState({ status: 'ready', product: fresh, error: null }); } catch { /* keep p */ }
    const incomplete = incompleteItemsFor(fresh);
    if (incomplete.length > 0) {
      setPublishGate({ product: fresh, incomplete });
      return;
    }
    await doPublish(fresh);
  }, [runSave, doPublish]);

  // ---- discard / revert --------------------------------------------
  const discard = useCallback(() => { resetDirty(); setRevertNonce((n) => n + 1); }, [resetDirty]);

  // ---- unsaved-changes guard --------------------------------------
  const blocker = useBlocker(
    useCallback(
      ({ currentLocation, nextLocation }) => isDirty && !savedRef.current && currentLocation.pathname !== nextLocation.pathname,
      [isDirty],
    ),
  );
  useEffect(() => {
    if (!isDirty) return undefined;
    const h = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [isDirty]);

  if (state.status === 'loading') return <LoadingState label="Loading product…" fullscreen />;
  if (state.status === 'error') {
    return (
      <div className="product-editor product-editor--error">
        <ErrorState message={state.error?.message} onRetry={() => setReloadNonce((n) => n + 1)} />
        <Link to="/products" className="btn btn--secondary">Back to products</Link>
      </div>
    );
  }

  const k = (key) => `${key}:${revertNonce}`;
  const dirtyLabels = dirtyKeys.map((key) => LABELS[key]).filter(Boolean);
  // The storefront routes /products/:id on the numeric storefrontId (every
  // product link there is built from it), NOT the slug — a slug never matches
  // the digits-only API route, so linking one here produced "Product not
  // found". Preview therefore targets the first variant that actually has a
  // storefrontId; without one there is no page to preview yet.
  const previewVariant = (product?.variants || [])
    .find((v) => v.status === 'ACTIVE' && v.storefrontId != null)
    ?? (product?.variants || []).find((v) => v.storefrontId != null);
  const previewUrl = product?.status === 'ACTIVE' && STORE_ORIGIN && previewVariant
    ? `${STORE_ORIGIN}/products/${previewVariant.storefrontId}`
    : null;

  // Step statuses — 'done' when the section's essentials are in place, else
  // 'todo'. No alarm styling on the default path.
  const skuCount = (product?.variants || []).reduce((n, v) => n + (v.skus?.length || 0), 0);
  const pricedSkus = (product?.variants || []).reduce(
    (n, v) => n + (v.skus || []).filter((s) => s.priceMinor != null && s.priceMinor > 0).length, 0,
  );
  const configuredSkus = product?.inventorySummary?.configuredSkus || 0;
  const stepStatus = {
    basic: (hasBasics && product?.productTypeCodeId && product?.fitCodeId) ? 'done' : 'todo',
    media: (product?.media || []).length ? 'done' : 'todo',
    category: (product?.categories || []).length ? 'done' : 'todo',
    sizes: (skuCount > 0 || product?.sizeGuide?.id || offeredSizes.length > 0) ? 'done' : 'todo',
    variants: skuCount ? 'done' : 'todo',
    pricing: skuCount > 0 && pricedSkus === skuCount ? 'done' : 'todo',
    shipping: product?.shipping?.rateReady ? 'done' : 'todo',
    inventory: configuredSkus > 0 ? 'done' : 'todo',
    seo: (product?.seoTitle && product?.seoDescription) ? 'done' : 'todo',
    setup: product?.status === 'ACTIVE' ? 'done' : 'todo',
  };
  const steps = STEP_DEFS.map((s) => ({ ...s, status: stepStatus[s.key] || 'todo' }));

  const locked = (label) => (
    <LockedSection label={label} busy={ensuring} onUnlock={() => ensureDraft().catch((e) => setSaveError(e.message))} />
  );

  return (
    <div className={`product-editor${isCreate ? ' product-editor--create' : ''}`}>
      <div className="editor-bar">
        <div className="editor-bar__id">
          <button type="button" className="editor-bar__back" onClick={() => navigate('/products')} aria-label="Back to products">←</button>
          <div>
            <p className="editor-bar__crumb">
              <Link to="/products">Products</Link>
              <span aria-hidden="true"> › </span>
              {isCreate ? 'Create product' : (product?.name || 'Product')}
            </p>
            <h1 className="editor-bar__name">
              {isCreate ? 'Create product' : (product?.name || 'Product')}
              {isCreate && <Badge tone="warn">DRAFT</Badge>}
            </h1>
            <p className="editor-bar__sub">
              {isCreate && !product
                ? <span className="text-faint">Add the basics, photos and variants to start selling.</span>
                : isCreate
                  ? <span className="text-faint">Draft saved. Keep going or publish when ready.</span>
                  : <>
                      <Badge>{product.status}</Badge>
                      <code>{product.slug}</code>
                      {product.publishedAt && <span className="text-faint"> · published {formatDateTime(product.publishedAt)}</span>}
                    </>}
            </p>
          </div>
        </div>
        <div className="editor-bar__actions">
          {isDirty && !isCreate && <span className="editor-bar__dirty">Unsaved: {dirtyLabels.join(', ')}</span>}
          {previewUrl
            ? <a className="btn btn--secondary" href={previewUrl} target="_blank" rel="noreferrer">Preview</a>
            : (
              // Say WHY it is unavailable — a silently missing button reads as
              // a broken editor, and a Preview that 404s is worse.
              <span className="btn btn--secondary is-disabled" aria-disabled="true"
                title={product?.status !== 'ACTIVE'
                  ? 'Available after publishing — a draft has no public page.'
                  : 'Add a colour variant first; the storefront page is keyed on it.'}>
                Preview
              </span>
            )}

          {!isCreate && canWrite && (
            <Button
              variant={product.status === 'ACTIVE' ? 'secondary' : 'primary'}
              busy={statusBusy}
              onClick={async () => { await changeStatus(product.id, NEXT_STATUS[product.status]); setReloadNonce((n) => n + 1); }}
            >
              {STATUS_ACTION[product.status]}
            </Button>
          )}
          {!isCreate && isDirty && <Button variant="danger-solid" onClick={discard}>Discard</Button>}
          {!isCreate && canWrite && (
            <Button busy={saving} disabled={!isDirty} onClick={() => runSave('changes')}>Save changes</Button>
          )}

          {isCreate && canWrite && (
            <>
              {product && dirtyKeys.length > 0 && (
                <Button variant="secondary" busy={saving} onClick={() => runSave('changes')}>Save</Button>
              )}
              <Button variant="secondary" busy={saving} onClick={() => runSave('draft')}>Save as draft</Button>
              <Button variant="success" busy={saving || statusBusy} onClick={handlePublish}>Publish product</Button>
            </>
          )}
        </div>
      </div>

      <StepNav steps={steps} activeSection={activeSection} onJump={jumpTo} />

      {(saveError || statusError) && <InlineAlert tone="error">{saveError || statusError?.message}</InlineAlert>}

      <div className="editor-grid">
        <div className="editor-grid__main">
          <SectionCard id="section-basic" title="Basic information"
            description="Name, type, fit, SKU identity codes and the descriptions shown on the storefront.">
            <GeneralTab
              key={k('general')} ref={generalRef} product={product} canWrite={canWrite} embedded
              onSaved={onSaved} onDirtyChange={(d) => report('general', d)} onFormChange={setBasic}
            />
          </SectionCard>

          <SectionCard id="section-media" title="Media"
            description="Upload clear photos of your product. The first image is the storefront cover.">
            {product ? <MediaTab key={k('media')} product={product} canWrite={canWrite} onSaved={onSaved} /> : locked('Media')}
          </SectionCard>

          <SectionCard id="section-category" title="Category"
            description="The storefront category this product lists under. The primary category drives category-page listing. Collections are set in Basic information.">
            {product
              ? (
                <CategoriesTab key={k('categories')} ref={categoriesRef} product={product} canWrite={canWrite} embedded
                  onSaved={onSaved} onDirtyChange={(d) => report('categories', d)} />
              )
              : locked('Category')}
          </SectionCard>

          <SectionCard id="section-sizes" title="Size selection"
            description="The size range this product is sold in, and the size guide shown on its PDP.">
            {product ? (
              <div className="stacked-forms">
                <SizeSelectionSection product={product} canWrite={canWrite}
                  offeredSizes={offeredSizes} onOfferedSizesChange={setOfferedSizes} />
                <SizeGuideTab key={k('sizeGuide')} ref={sizeGuideRef} product={product} canWrite={canWrite} embedded
                  onSaved={onSaved} onDirtyChange={(d) => report('sizeGuide', d)} />
              </div>
            ) : locked('Size selection')}
          </SectionCard>

          <SectionCard id="section-variants" title="Variant &amp; SKU"
            description="Choose colours and sizes and the backend generates the canonical SKU for each.">
            {product
              ? <VariantsTab key={k('variants')} product={product} canWrite={canWrite} onSaved={onSaved} offeredSizes={offeredSizes} />
              : locked('Variant & SKU')}
          </SectionCard>

          <SectionCard id="section-pricing" title="Pricing"
            description="Set the price and optional sale price for every SKU. Stored in paise; enter rupees.">
            {product && skuCount > 0
              ? (
                <PricingTab key={k('pricing')} ref={pricingRef} product={product} canWrite={canWrite}
                  onSaved={onSaved} onDirtyChange={(d) => report('pricing', d)} />
              )
              : product
                ? <p className="text-faint">Add colours and sizes in Variants first — each SKU then appears here to price.</p>
                : locked('Pricing')}
          </SectionCard>

          <SectionCard id="section-shipping" title="Shipping"
            description="Packed weight and box size so shipping rates and fulfilment work.">
            {product ? (
              <ShippingTab key={k('shipping')} ref={shippingRef} product={product} canWrite={canWrite} embedded
                onSaved={onSaved} onDirtyChange={(d) => report('shipping', d)} />
            ) : locked('Shipping')}
          </SectionCard>

          <SectionCard id="section-inventory" title="Inventory"
            description="Choose a warehouse and set opening stock per SKU. Every change is an audited adjustment.">
            {product ? (
              <div className="stacked-forms">
                <InventoryTab key={k('inventory')} product={product} canWrite={canWrite} onSaved={onSaved} />
                <p className="text-faint">
                  The same stock is shown in the <Link to="/inventory" className="linkish">Inventory module</Link> and
                  on each <Link to="/warehouses" className="linkish">warehouse</Link> — one backend source, so a sale,
                  a return restock or an adjustment made anywhere is reflected everywhere.
                </p>
              </div>
            ) : (
              <p className="text-faint">Inventory appears once the product has SKUs.</p>
            )}
          </SectionCard>

          <SectionCard id="section-seo" title="SEO"
            description="The search-engine title and description used on the storefront product page.">
            {product
              ? (
                <SeoTab key={k('seo')} ref={seoRef} product={product} canWrite={canWrite} embedded
                  onSaved={onSaved} onDirtyChange={(d) => report('seo', d)} />
              )
              : locked('SEO')}
          </SectionCard>

          <SectionCard id="section-setup" title="Setup"
            description="A final readiness check across every step before the product goes live.">
            {product ? (
              <div className="setup-review">
                <SetupReadinessCard product={product} basic={basic} onJump={jumpTo} embedded />
                {isCreate
                  ? (
                    <div className="setup-review__actions">
                      <Button variant="secondary" busy={saving} onClick={() => runSave('draft')}>Save as draft</Button>
                      <Button variant="success" busy={saving || statusBusy} onClick={handlePublish}>Publish product</Button>
                    </div>
                  )
                  : (
                    <p className="text-faint">
                      This product is <strong>{product.status}</strong>. Use the {STATUS_ACTION[product.status]} button in the header to change that.
                    </p>
                  )}
              </div>
            ) : locked('Setup')}
          </SectionCard>
        </div>

        <aside className="editor-grid__rail">
          <div className="rail-card">
            <h3 className="rail-card__title">Product status</h3>
            <p className="rail-card__value">
              <Badge>{product?.status || 'DRAFT'}</Badge>
            </p>
            <dl className="rail-facts">
              <div>
                <dt>Visibility</dt>
                <dd>{product?.status === 'ACTIVE' ? 'Storefront visible' : 'Hidden'}</dd>
              </div>
            </dl>
            <p className="text-faint">
              {!product
                ? 'Nothing is saved yet. Save as draft to keep your work, or publish when ready.'
                : product.status === 'ACTIVE'
                  ? 'Live on the storefront (needs an active variant + SKU).'
                  : product.status === 'DRAFT'
                    ? 'Only you and other admins can see this product until it is published.'
                    : 'Archived — hidden from the storefront.'}
            </p>
            {!isCreate && canWrite && (
              <Button
                variant={product.status === 'ACTIVE' ? 'secondary' : 'primary'}
                busy={statusBusy}
                onClick={async () => { await changeStatus(product.id, NEXT_STATUS[product.status]); setReloadNonce((n) => n + 1); }}
              >
                {STATUS_ACTION[product.status]}
              </Button>
            )}
          </div>

          <SetupReadinessCard product={product} basic={basic} onJump={jumpTo} />

          <div className="rail-card">
            <h3 className="rail-card__title">Product summary</h3>
            <QuickOverview product={product} basic={basic} />
            <dl className="rail-facts">
              <div><dt>Type</dt><dd>{titleCase(product?.productType || basic.productType) || '—'}</dd></div>
              <div><dt>Fit</dt><dd>{(product?.fit || basic.fit) ? titleCase(product?.fit || basic.fit) : '—'}</dd></div>
              <div><dt>Category</dt><dd>{product?.category?.name || '—'}</dd></div>
              <div><dt>Collections</dt><dd>{(product?.collections || []).length || '—'}</dd></div>
              <div><dt>Size guide</dt><dd>{product?.sizeGuide?.name || 'Not assigned'}</dd></div>
            </dl>
          </div>

          <div id="section-tax">
            <TaxCard product={product} canManageTax={canManageTax} onSaved={onSaved} />
          </div>

          <div className="rail-card">
            <h3 className="rail-card__title">Need help?</h3>
            <p className="text-faint">Questions about setting up a product? Our support team can help.</p>
            <Link to="/support" className="linkish">Contact support</Link>
          </div>
        </aside>
      </div>

      <UnsavedChangesDialog
        open={blocker.state === 'blocked'}
        sections={dirtyLabels.length ? dirtyLabels : ['this product']}
        onKeepEditing={() => blocker.reset?.()}
        onDiscard={() => { discard(); blocker.proceed?.(); }}
      />

      <Dialog
        open={Boolean(publishGate)}
        onClose={() => setPublishGate(null)}
        title={`Publish with ${publishGate?.incomplete.length} item${publishGate?.incomplete.length === 1 ? '' : 's'} incomplete?`}
        actions={
          <>
            <Button variant="ghost" onClick={() => setPublishGate(null)}>Keep editing</Button>
            <Button variant="success"
              busy={statusBusy}
              onClick={async () => { const g = publishGate; setPublishGate(null); await doPublish(g.product); }}
            >
              Publish anyway
            </Button>
          </>
        }
      >
        <p>These are not blocking, but the product may not be purchasable until they are done:</p>
        <ul className="publish-gate__list">
          {publishGate?.incomplete.map((it) => (
            <li key={it.section}>
              {it.label}
              <button type="button" className="linkish" onClick={() => { setPublishGate(null); jumpTo(it.section); }}>Go</button>
            </li>
          ))}
        </ul>
      </Dialog>
    </div>
  );
}

export default ProductEditor;
