import { titleCase, formatPriceRange } from '../../../utils/format.js';

// Compact live preview of the product being built. Reads only real state —
// the persisted product aggregate plus the in-progress basic-info form.
function priceRangeFrom(product) {
  const skus = (product?.variants || []).flatMap((v) => v.skus || []);
  if (!skus.length) return null;
  const eff = skus.map((s) => (s.salePriceMinor != null ? s.salePriceMinor : s.priceMinor)).filter((n) => n != null);
  const max = skus.map((s) => s.priceMinor).filter((n) => n != null);
  if (!eff.length) return null;
  return { minMinor: Math.min(...eff), maxMinor: Math.max(...max), currency: skus[0].currency || 'INR' };
}

export function QuickOverview({ product, basic }) {
  const b = basic || {};
  const name = product?.name || b.name || 'Untitled product';
  const type = product?.productType || b.productType;
  const fit = product?.fit || b.fit;
  const brand = product?.brand || b.brand || 'CORCOTTON';
  const desc = product?.shortDescription || b.shortDescription || product?.description || b.description || '';

  const variants = product?.variants || [];
  const skuCount = variants.reduce((n, v) => n + (v.skus?.length || 0), 0);
  const sizeSet = new Set(variants.flatMap((v) => (v.skus || []).map((s) => s.size)));
  const primary = (product?.media || []).find((m) => m.isPrimary && m.mediaType !== 'GRADIENT')
    || (product?.media || []).find((m) => m.mediaType === 'IMAGE');
  const price = priceRangeFrom(product);
  const rateReady = product?.shipping?.rateReady;

  return (
    <div className="quick-overview">
      <div className="quick-overview__media">
        {primary
          ? <img src={primary.url} alt="" />
          : <span className="quick-overview__media-empty" aria-hidden="true">◫</span>}
      </div>
      <div className="quick-overview__body">
        <p className="quick-overview__name">{name}</p>
        <p className="quick-overview__meta">
          {[fit && titleCase(fit), type && titleCase(type), brand].filter(Boolean).join(' · ')}
        </p>
        {desc && <p className="quick-overview__desc">{desc}</p>}
        <div className="quick-overview__stats">
          <span>{variants.length} colour{variants.length === 1 ? '' : 's'}</span>
          <span>{sizeSet.size} size{sizeSet.size === 1 ? '' : 's'}</span>
          <span>{skuCount} SKU{skuCount === 1 ? '' : 's'}</span>
        </div>
        <p className="quick-overview__price">{price ? formatPriceRange(price) : 'No pricing yet'}</p>
        <p className={`quick-overview__ship${rateReady ? ' is-ready' : ''}`}>
          {rateReady ? 'Shipping ready' : 'Shipping: weight not set'}
        </p>
      </div>
    </div>
  );
}

export default QuickOverview;
