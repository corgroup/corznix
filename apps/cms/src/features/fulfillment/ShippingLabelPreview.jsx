import { useState } from 'react';
import './ShippingLabelPreview.css';

// A verification panel, not a substitute for the carrier's own label.
//
// Its whole job is to let a warehouse operator answer one question before they
// tape a label to a box: "are BOTH addresses on this parcel complete?" A
// truncated Ship From means a failed RTO; a truncated Ship To means a failed
// delivery. Both are expensive and both are invisible on a folded thermal
// label until it is too late.
//
// So this renders every field the carrier prints, and marks the missing ones
// rather than quietly rendering a shorter address.

function Line({ children }) {
  return children ? <span className="lbl__line">{children}</span> : null;
}

function Missing({ what }) {
  return <span className="lbl__missing">{what} missing</span>;
}

/**
 * A rough Code-128-looking barcode drawn from the AWB's own digits.
 *
 * It is NOT scannable and must never be treated as one — the scannable
 * barcode is on the carrier's PDF. This is a visual placeholder so the
 * operator recognises the layout; labelling it as such is the point.
 */
function BarcodeMark({ value }) {
  const digits = String(value || '').replace(/[^0-9A-Za-z]/g, '');
  if (!digits) return null;
  const bars = [];
  for (let i = 0; i < digits.length; i += 1) {
    const code = digits.charCodeAt(i);
    bars.push(1 + (code % 3), 1 + ((code >> 2) % 2), 1 + ((code >> 4) % 3), 1);
  }
  return (
    <div className="lbl__barcode" aria-hidden="true">
      <svg viewBox={`0 0 ${bars.reduce((a, b) => a + b, 0)} 40`} preserveAspectRatio="none" role="presentation">
        {(() => {
          let x = 0;
          return bars.map((w, i) => {
            const el = i % 2 === 0 ? <rect key={i} x={x} y="0" width={w} height="40" /> : null;
            x += w;
            return el;
          });
        })()}
      </svg>
    </div>
  );
}

export function ShippingLabelPreview({ order, shipment, warehouse }) {
  const [open, setOpen] = useState(false);
  const to = order.shippingAddress || {};
  const toLine1 = to.addressLine1 || to.address_line1;
  const toLine2 = to.addressLine2 || to.address_line2;
  const toPin = to.postalCode || to.postal_code;
  const toName = [to.firstName || to.first_name, to.lastName || to.last_name].filter(Boolean).join(' ');
  const contact = warehouse?.pickupContact;
  const cod = Number(shipment.codCollectionMinor || 0);

  const gaps = [
    !warehouse?.addressLine1 && 'warehouse street address',
    !warehouse?.postalCode && 'warehouse PIN code',
    !contact?.phone && 'warehouse contact number',
    !toLine1 && 'customer street address',
    !toPin && 'customer PIN code',
    !to.phone && 'customer phone',
  ].filter(Boolean);

  return (
    <div className="lbl-panel">
      <button type="button" className="lbl-panel__toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        Check what prints on the label
        {gaps.length > 0 && <span className="lbl-panel__warn">{gaps.length} field{gaps.length === 1 ? '' : 's'} missing</span>}
      </button>

      {open && (
        <>
          {gaps.length > 0 && (
            <p className="lbl-panel__gaps">
              Incomplete on this parcel: {gaps.join(', ')}. Fix these before the label goes on the box.
            </p>
          )}

          <div className="lbl" role="group" aria-label="Shipping label preview">
            <div className="lbl__top">
              <div className="lbl__brand">CORCOTTON</div>
              <div className="lbl__carrier">
                {shipment.providerCode || 'Carrier'}
                <span>{order.shippingMethod === 'EXPRESS' ? 'Express' : 'Surface'}</span>
              </div>
            </div>

            <div className="lbl__awb">
              <BarcodeMark value={shipment.awbNumber} />
              <p className="lbl__awb-number">{shipment.awbNumber || 'AWB not assigned'}</p>
              <p className="lbl__awb-note">Representation only — scan the carrier PDF, not this preview.</p>
            </div>

            <div className="lbl__addresses">
              <div className="lbl__addr">
                <p className="lbl__addr-head">Ship To</p>
                <Line>{toName || <Missing what="Name" />}</Line>
                <Line>{toLine1 || <Missing what="Address" />}</Line>
                <Line>{toLine2}</Line>
                <Line>{[to.city, to.state].filter(Boolean).join(', ')}</Line>
                <Line>{toPin ? <strong className="lbl__pin">{toPin}</strong> : <Missing what="PIN" />}</Line>
                <Line>{to.country || 'India'}</Line>
                <Line>{to.phone ? `Ph ${to.phone}` : <Missing what="Phone" />}</Line>
              </div>

              <div className="lbl__addr lbl__addr--from">
                <p className="lbl__addr-head">Ship From / Return To</p>
                <Line>{warehouse?.name || <Missing what="Warehouse" />}</Line>
                <Line>{warehouse?.addressLine1 || <Missing what="Address" />}</Line>
                <Line>{warehouse?.addressLine2}</Line>
                <Line>{[warehouse?.city, warehouse?.state].filter(Boolean).join(', ')}</Line>
                <Line>{warehouse?.postalCode ? <strong className="lbl__pin">{warehouse.postalCode}</strong> : <Missing what="PIN" />}</Line>
                <Line>{warehouse?.country === 'IN' || !warehouse?.country ? 'India' : warehouse.country}</Line>
                <Line>{contact?.phone ? `Ph ${contact.phone}` : <Missing what="Contact" />}</Line>
                {contact?.name && <Line>{`Attn ${contact.name}`}</Line>}
              </div>
            </div>

            <div className="lbl__payment">
              <div className={`lbl__pay ${cod > 0 ? 'lbl__pay--cod' : ''}`}>
                {cod > 0 ? 'COD' : 'PREPAID'}
              </div>
              {cod > 0 && (
                <div className="lbl__cod">
                  <span>Collect</span>
                  <strong>₹{(cod / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong>
                </div>
              )}
              <dl className="lbl__refs">
                <div><dt>Order</dt><dd>{order.orderNumber}</dd></div>
                <div><dt>Shipment</dt><dd>{shipment.shipmentNumber}</dd></div>
                {shipment.package?.weightGrams && <div><dt>Weight</dt><dd>{shipment.package.weightGrams} g</dd></div>}
              </dl>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default ShippingLabelPreview;
