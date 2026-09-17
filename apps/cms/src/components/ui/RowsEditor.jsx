import { makeRowKey } from './rowHelpers.js';
import './RowsEditor.css';

/**
 * Generic repeatable-row table editor. Domain code supplies the columns and
 * how each cell renders; add / remove / reorder are handled here.
 *
 * columns: [{ key, label, width?, render(row, patch, ctx) }]
 *   patch(partialRow)  -> merges into that row
 *   ctx = { index, disabled }
 */
export function RowsEditor({
  rows, onChange, columns, makeRow,
  addLabel = 'Add row', minRows = 0, maxRows = null,
  disabled = false, emptyLabel = 'Nothing here yet.',
}) {
  const patch = (i, part) => onChange(rows.map((r, j) => (j === i ? { ...r, ...part } : r)));
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= rows.length) return;
    const n = [...rows];
    [n[i], n[j]] = [n[j], n[i]];
    onChange(n);
  };
  const remove = (i) => onChange(rows.filter((_, j) => j !== i));
  const add = () => onChange([...rows, { _k: makeRowKey(), ...makeRow() }]);
  const spanCols = columns.length + (disabled ? 0 : 1);

  return (
    <div className="rows-editor">
      <div className="table-wrap">
        <table className="data-table rows-editor__table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} style={c.width ? { width: c.width } : undefined}>{c.label}</th>
              ))}
              {!disabled && <th className="rows-editor__actions-head" scope="col">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row._k ?? i}>
                {columns.map((c) => (
                  <td key={c.key}>{c.render(row, (part) => patch(i, part), { index: i, disabled })}</td>
                ))}
                {!disabled && (
                  <td className="rows-editor__actions">
                    <button type="button" className="linkish" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move row ${i + 1} up`}>↑</button>
                    <button type="button" className="linkish" onClick={() => move(i, 1)} disabled={i === rows.length - 1} aria-label={`Move row ${i + 1} down`}>↓</button>
                    <button type="button" className="linkish rows-editor__remove" onClick={() => remove(i)} disabled={rows.length <= minRows} aria-label={`Remove row ${i + 1}`}>✕</button>
                  </td>
                )}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={spanCols} className="data-table__empty">{emptyLabel}</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {!disabled && (
        <div className="rows-editor__toolbar">
          <button type="button" className="btn btn--secondary" onClick={add} disabled={maxRows != null && rows.length >= maxRows}>
            + {addLabel}
          </button>
          {maxRows != null && <span className="rows-editor__count">{rows.length} / {maxRows}</span>}
        </div>
      )}
    </div>
  );
}

// Compact text / number cell input for use inside RowsEditor render fns.
export function CellInput({ value, onChange, type = 'text', placeholder, disabled, ariaLabel, ...rest }) {
  return (
    <input
      className="rows-editor__input"
      type={type}
      value={value ?? ''}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => onChange(type === 'number'
        ? (e.target.value === '' ? null : Number(e.target.value))
        : e.target.value)}
      {...rest}
    />
  );
}

export function CellSelect({ value, onChange, options, disabled, ariaLabel }) {
  return (
    <select className="rows-editor__input" value={value ?? ''} disabled={disabled} aria-label={ariaLabel} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => {
        const [v, l] = Array.isArray(o) ? o : [o, o];
        return <option key={v} value={v}>{l}</option>;
      })}
    </select>
  );
}

export function DirtyPill({ dirty, savedLabel = 'No unsaved changes' }) {
  return (
    <span className={`pill pill--${dirty ? 'warn' : 'muted'}`}>
      {dirty ? 'Unsaved changes' : savedLabel}
    </span>
  );
}

export default RowsEditor;
