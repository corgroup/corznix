import { useMemo } from 'react';
import { InlineAlert } from '../../../components/feedback/InlineAlert.jsx';
import { useSkuOptions, allowedSizes, sizeFamilyFor } from '../skuIdentity.js';

// Size Selection step. CORCOTTON has no product-level "offered sizes" column —
// sizes exist only as SKUs. So this step does two real things:
//   1. Assigns the storefront size guide (SizeGuideTab, rendered alongside).
//   2. Lets the operator pre-pick the size range for the product. That
//      selection is held in the editor and pre-fills the "add sizes" grid in
//      the next step, where each size becomes a real SKU. A size that is
//      already a live SKU shows checked + locked here (managed in Variant &
//      SKU), so the grid always reflects backend truth.
export function SizeSelectionSection({ product, canWrite, offeredSizes, onOfferedSizesChange }) {
  const { data: options, status } = useSkuOptions();
  const family = sizeFamilyFor(options, product?.productTypeCodeId);
  const sizes = allowedSizes(options, family);

  const liveSizes = useMemo(() => {
    const set = new Set();
    for (const v of product?.variants || []) {
      for (const s of v.skus || []) if (s.status !== 'ARCHIVED') set.add(s.size);
    }
    return set;
  }, [product]);

  if (!product?.productTypeCodeId) {
    return (
      <p className="text-faint">
        Choose a product type code in <strong>Basic information</strong> — the available size range comes from its size family.
      </p>
    );
  }
  if (status === 'loading') return <p className="text-faint">Loading sizes…</p>;
  if (status === 'error') return <InlineAlert tone="warning">Could not load the size rules.</InlineAlert>;
  if (!sizes.length) return <InlineAlert tone="warning">No size rules are configured for this product type&rsquo;s size family.</InlineAlert>;

  const toggle = (z) => {
    if (liveSizes.has(z)) return; // already a SKU — manage it in Variant & SKU
    const next = offeredSizes.includes(z)
      ? offeredSizes.filter((x) => x !== z)
      : [...offeredSizes, z];
    onOfferedSizesChange(next);
  };

  const selectedCount = new Set([...liveSizes, ...offeredSizes]).size;

  return (
    <div className="tab-body">
      <p className="tab-body__hint">
        Pick the sizes this product will be sold in (size family: <strong>{family}</strong>).
        Each selected size becomes one SKU per colour in <strong>Variant &amp; SKU</strong> — the SKUs are the
        source of truth; this just pre-fills them.
      </p>
      <div className="size-chips">
        {sizes.map((z) => {
          const live = liveSizes.has(z);
          const on = live || offeredSizes.includes(z);
          return (
            <label
              key={z}
              className={`size-chip${on ? ' is-on' : ''}`}
              title={live ? 'Already a live SKU — manage in Variant & SKU' : undefined}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={!canWrite || live}
                onChange={() => toggle(z)}
              />
              {z}{live ? ' ✓' : ''}
            </label>
          );
        })}
      </div>
      <p className="tab-body__hint">
        {selectedCount > 0
          ? `${selectedCount} size${selectedCount === 1 ? '' : 's'} selected. A ✓ marks a size that already has a live SKU on at least one colour.`
          : 'No sizes selected yet.'}
      </p>
    </div>
  );
}

export default SizeSelectionSection;
