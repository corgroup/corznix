import { Button } from '../../components/ui/Button.jsx';
import { MAX_RATE_BANDS, bandLines } from './rateBands.js';

// Rows of "per-piece value up to (₹)" + "GST %". The last row covers everything
// above the previous limit, so it has no limit of its own.
export function RateBandsEditor({ bands, onChange, idPrefix }) {
  const update = (i, key) => (e) => onChange(bands.map((b, j) => (j === i ? { ...b, [key]: e.target.value } : b)));
  // Whichever row ends up last loses its limit.
  const remove = (i) => onChange(bands.filter((_, j) => j !== i).map((b, j, rows) => (j === rows.length - 1 ? { ...b, max: '' } : b)));
  const add = () => onChange([...bands.slice(0, -1), { max: '', rate: '' }, bands[bands.length - 1]]);

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {bands.map((b, i) => {
        const last = i === bands.length - 1;
        const prev = i > 0 ? bands[i - 1].max : '';
        return (
          <div key={i} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8 }}>
            {last ? (
              <span className="form-field__label" style={{ flex: '1 1 180px', paddingBottom: 10 }}>
                {prev ? `Above ₹${prev}` : 'Above the previous band'}
              </span>
            ) : (
              <label className="form-field" style={{ flex: '1 1 180px', margin: 0 }}>
                <span className="form-field__label">{i === 0 ? 'Per-piece value up to (₹)' : `Above ₹${prev || '…'}, up to (₹)`}</span>
                <input id={`${idPrefix}-max-${i}`} className="form-field__input" type="number" min="1" step="0.01" inputMode="decimal"
                  value={b.max} onChange={update(i, 'max')} />
              </label>
            )}
            <label className="form-field" style={{ flex: '0 1 110px', margin: 0 }}>
              <span className="form-field__label">GST %</span>
              <input id={`${idPrefix}-rate-${i}`} className="form-field__input" type="number" min="0" max="50" step="0.01" inputMode="decimal"
                value={b.rate} onChange={update(i, 'rate')} />
            </label>
            {bands.length > 2 && (
              <Button type="button" variant="secondary" onClick={() => remove(i)}>Remove band {i + 1}</Button>
            )}
          </div>
        );
      })}
      {bands.length < MAX_RATE_BANDS && (
        <div><Button type="button" variant="secondary" onClick={add}>Add band</Button></div>
      )}
    </div>
  );
}

export function RateBandsSummary({ rateBands }) {
  return (
    <div style={{ display: 'grid', gap: 2 }}>
      {bandLines(rateBands).map((line) => <span key={line}>{line}</span>)}
    </div>
  );
}

export default RateBandsEditor;
