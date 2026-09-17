// Product-setup readiness — every row is computed from live state (the product
// aggregate, or the in-progress create form before a draft exists). Nothing is
// a guess: "Needs attention" means a real downstream operation (checkout rate,
// invoice, storefront listing) cannot complete yet.
const good = (detail) => ({ tone: 'good', detail });
const warn = (detail) => ({ tone: 'warn', detail });
const muted = (detail) => ({ tone: 'muted', detail });

function buildRows(product, basic) {
  const b = basic || {};
  const variants = product?.variants || [];
  const media = product?.media || [];
  const categories = product?.categories || [];
  const configuredSkus = product?.inventorySummary?.configuredSkus || 0;
  const skuCount = variants.reduce((n, v) => n + (v.skus?.length || 0), 0);
  const pricedSkus = variants.reduce(
    (n, v) => n + (v.skus || []).filter((s) => s.priceMinor != null && s.priceMinor > 0).length, 0,
  );
  const shipping = product?.shipping || { rateReady: false, status: 'INCOMPLETE' };

  const basicComplete = Boolean(
    (product?.name || b.name) && (product?.productType || b.productType)
    && (product?.productTypeCodeId || b.productTypeCodeId) && (product?.fitCodeId || b.fitCodeId),
  );
  const seoTitle = product?.seoTitle ?? b.seoTitle;
  const seoDescription = product?.seoDescription ?? b.seoDescription;

  // The ten steps of the create flow, in order (Setup itself is this card).
  return [
    {
      key: 'basic', label: 'Add basic information', section: 'section-basic',
      ...(basicComplete
        ? good('Complete')
        : warn((product?.name || b.name) ? 'Type & fit codes needed' : 'Name & type needed')),
    },
    {
      key: 'media', label: 'Add product media', section: 'section-media',
      ...(media.length ? good(`${media.length} image${media.length === 1 ? '' : 's'}`) : warn('No media')),
    },
    {
      key: 'category', label: 'Assign a category', section: 'section-category',
      ...(categories.length ? good(`${categories.length} assigned`) : warn('None assigned')),
    },
    {
      key: 'sizes', label: 'Select sizes', section: 'section-sizes',
      ...(skuCount
        ? good('From SKUs')
        : product?.sizeGuide?.id ? good('Size guide set') : muted('Set in Variant & SKU')),
    },
    {
      key: 'variants', label: 'Create variants & SKUs', section: 'section-variants',
      ...(skuCount ? good(`${skuCount} SKU${skuCount === 1 ? '' : 's'}`) : warn('None yet')),
    },
    {
      key: 'pricing', label: 'Set pricing', section: 'section-pricing',
      ...(skuCount === 0
        ? muted('After SKUs')
        : pricedSkus === skuCount ? good('All SKUs priced') : warn(`${skuCount - pricedSkus} unpriced`)),
    },
    {
      key: 'shipping', label: 'Add shipping details', section: 'section-shipping',
      ...(shipping.rateReady
        ? good(shipping.status === 'COMPLETE' ? 'Ready · full box' : 'Weight set')
        : warn('Weight missing')),
    },
    {
      key: 'inventory', label: 'Check inventory', section: 'section-inventory',
      ...(skuCount === 0
        ? muted('After SKUs')
        : configuredSkus > 0 ? good(`${configuredSkus} SKU${configuredSkus === 1 ? '' : 's'} stocked`) : muted('No stock yet')),
    },
    {
      key: 'seo', label: 'Optimize SEO', section: 'section-seo',
      ...((seoTitle && seoDescription) ? good('Complete') : muted('Optional')),
    },
  ];
}

export function SetupReadinessCard({ product, basic, onJump, embedded = false }) {
  const items = buildRows(product, basic);
  const scored = items.filter((i) => i.tone !== 'muted');
  const done = scored.filter((i) => i.tone === 'good').length;
  const attention = items.filter((i) => i.tone === 'warn').length;
  const pct = scored.length ? Math.round((done / scored.length) * 100) : 0;

  return (
    <div className={embedded ? 'readiness-block' : 'rail-card'}>
      <h3 className="rail-card__title">
        Setup checklist
        {attention > 0 && <span className="rail-card__pill rail-card__pill--warn">{attention} incomplete</span>}
      </h3>
      <p className="readiness__progress-label">{done} of {scored.length} completed</p>
      <div className="readiness__bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <ul className="readiness">
        {items.map((i) => (
          <li key={i.key} className="readiness__row">
            <button type="button" className="readiness__label" onClick={() => onJump?.(i.section)}>
              <span className={`readiness__tick readiness__tick--${i.tone}`} aria-hidden="true" />
              {i.label}
            </button>
            <span className={`readiness__state readiness__state--${i.tone}`}>{i.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default SetupReadinessCard;
