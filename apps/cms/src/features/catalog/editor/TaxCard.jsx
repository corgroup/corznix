import { useEffect, useState } from 'react';
import { Button } from '../../../components/ui/Button.jsx';
import { Select } from '../../../components/ui/Select.jsx';
import { InlineAlert } from '../../../components/feedback/InlineAlert.jsx';
import { adminApi } from '../../../api/adminApi.js';
import { useMutation } from '../useMutation.js';
import { bandLines, formatRate, profileRateLabel } from '../../tax/rateBands.js';

// B4 (Phase 3) — surfaces the product's assigned tax profile and lets a
// `tax.manage` operator assign one, reusing the existing tax module
// (`POST /tax-profiles/assign`). HSN / GST are never invented here; the
// profiles come from the Tax Profiles registry.
export function TaxCard({ product, canManageTax, onSaved }) {
  const current = product?.taxProfile;
  const productId = product?.id || null;
  const [profiles, setProfiles] = useState([]);
  const [choice, setChoice] = useState(current?.id ?? '');
  const [assign, { busy, error }] = useMutation((id) => adminApi.tax.assign(productId, id));
  const [okMsg, setOkMsg] = useState('');

  useEffect(() => {
    if (!canManageTax) return;
    adminApi.tax.list().then(
      (d) => setProfiles((d.taxProfiles || []).filter((p) => p.status === 'ACTIVE')),
      () => {},
    );
  }, [canManageTax]);

  const dirty = (choice || null) !== (current?.id ?? null);

  return (
    <div className="rail-card" id="section-tax">
      <h3 className="rail-card__title">Tax profile</h3>
      {current ? (
        <p className="rail-card__value">
          {current.name}
          <span className="text-faint"> · HSN {current.hsnSac} · {current.rateBands?.length ? 'GST by price' : `${formatRate(current.gstRateBps)} GST`}</span>
          {current.rateBands?.length > 0 && (
            <span className="text-faint" style={{ display: 'block', fontSize: 12 }}>{bandLines(current.rateBands).join(' · ')}</span>
          )}
        </p>
      ) : (
        <p className="rail-card__value rail-card__value--warn">Not assigned — required for invoicing.</p>
      )}
      <p className="text-faint" style={{ fontSize: 11 }}>
        Garments up to ₹2,500/piece: 5% GST. Above ₹2,500/piece: 18% GST. A profile with price bands picks the rate from each piece&rsquo;s price after discount.
      </p>

      {!productId && canManageTax && (
        <p className="text-faint">Save the product first to assign a tax profile.</p>
      )}

      {productId && canManageTax && (
        <>
          <Select
            id="tax-profile"
            label="Assign profile"
            value={choice}
            onChange={(v) => { setChoice(v || ''); setOkMsg(''); }}
            includeBlank
            blankLabel="— choose —"
            options={profiles.map((p) => [p.id, `${p.name} (${profileRateLabel(p)})`])}
          />
          {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
          {okMsg && <InlineAlert tone="info">{okMsg}</InlineAlert>}
          <Button
            variant="secondary"
            busy={busy}
            disabled={!dirty || !choice}
            onClick={async () => { await assign(choice); setOkMsg('Tax profile assigned.'); onSaved(); }}
          >
            Assign
          </Button>
        </>
      )}
    </div>
  );
}

export default TaxCard;
