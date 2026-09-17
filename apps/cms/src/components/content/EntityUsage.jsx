import { useState } from 'react';
import { adminApi } from '../../api/adminApi.js';
import { useApiResource } from '../../hooks/useApiResource.js';
import { Dialog } from '../ui/Dialog.jsx';
import { Button } from '../ui/Button.jsx';
import './EntityUsage.css';

// Dependency awareness for anything the website links to (category,
// collection, content page). Links store a reference to the entity, so
// renaming, archiving or changing its URL updates every link automatically —
// and deleting it removes every link. These components show an editor WHERE
// that is before they act.

const NOUN = { CATEGORY: 'category', COLLECTION: 'collection', PAGE: 'page' };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function UsageList({ references }) {
  const groups = new Map();
  for (const r of references) {
    if (!groups.has(r.area)) groups.set(r.area, []);
    groups.get(r.area).push(r);
  }
  return (
    <div className="entity-usage__groups">
      {[...groups.entries()].map(([area, items]) => (
        <div key={area} className="entity-usage__group">
          <p className="entity-usage__area">{area}</p>
          <ul className="entity-usage__list">
            {items.map((r, i) => (
              <li key={`${r.where}-${r.label}-${i}`}>
                <span className="entity-usage__where">{r.where}</span>
                {r.label && <span className="entity-usage__label">“{r.label}”</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** "Used in N places on the website" — shown on the entity's edit form. */
export function EntityUsage({ type, id }) {
  const { status, data, error, reload } = useApiResource(() => adminApi.content.references(type, id));
  const [open, setOpen] = useState(false);
  if (status === 'loading') return <p className="entity-usage entity-usage--muted" role="status">Checking where this {NOUN[type]} is used on the website…</p>;
  if (status === 'error') {
    return (
      <p className="entity-usage entity-usage--error" role="alert">
        Could not check where this {NOUN[type]} is used: {error?.message}{' '}
        <button type="button" className="linkish" onClick={reload}>Try again</button>
      </p>
    );
  }
  const refs = data.references;
  if (!refs.length) {
    return <p className="entity-usage entity-usage--muted">Not linked from the header, menus, footer or homepage.</p>;
  }
  return (
    <div className="entity-usage">
      <button type="button" className="entity-usage__summary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span>Used in <strong>{plural(refs.length, 'place')}</strong> on the website</span>
        <span className="entity-usage__chev" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      <p className="entity-usage__hint">Renaming it, changing its URL or archiving it updates all of these automatically.</p>
      {open && <UsageList references={refs} />}
    </div>
  );
}

/** Delete confirmation that lists every link the delete will remove. */
export function EntityDeleteDialog({ open, ...props }) {
  if (!open) return null;
  return <DeleteDialogInner {...props} />;
}

function DeleteDialogInner({ type, id, name, note, onCancel, onConfirm }) {
  const { status, data, error } = useApiResource(() => adminApi.content.references(type, id));
  const [busy, setBusy] = useState(false);
  const refs = data?.references || [];
  const blockers = data?.blockers || [];
  const confirm = async () => {
    setBusy(true);
    try { await onConfirm(refs.length > 0); } finally { setBusy(false); }
  };
  return (
    <Dialog
      open
      onClose={onCancel}
      title={`Delete ${name}?`}
      actions={(
        <>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="danger-solid" busy={busy} disabled={status !== 'ready' || blockers.length > 0} onClick={confirm}>
            {refs.length ? `Delete and remove ${plural(refs.length, 'link')}` : `Delete ${NOUN[type]}`}
          </Button>
        </>
      )}
    >
      {status === 'loading' && <p role="status">Checking where this {NOUN[type]} is used…</p>}
      {status === 'error' && <p className="entity-usage entity-usage--error" role="alert">Could not check where it is used: {error?.message}. Deleting is disabled until this works.</p>}
      {status === 'ready' && blockers.length > 0 && (
        <div className="entity-usage entity-usage--error" role="alert">
          <strong>This {NOUN[type]} cannot be deleted yet:</strong>
          <ul className="entity-usage__blockers">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
          <span>Move those first, or archive it instead — archiving hides it (and its links) without losing anything.</span>
        </div>
      )}
      {status === 'ready' && (refs.length ? (
        <div className="entity-usage__dialog">
          <p>This {NOUN[type]} is linked from <strong>{plural(refs.length, 'place')}</strong>. Deleting it removes these links everywhere on the website:</p>
          <UsageList references={refs} />
          <p className="entity-usage__tip">To keep the links, archive it instead (they come back when it is active again), or remove just one link in the Header or Footer builder — that never deletes the {NOUN[type]}.</p>
        </div>
      ) : (
        <p>It is not linked from the header, menus, footer or homepage.</p>
      ))}
      {note && <p className="entity-usage__note">{note}</p>}
    </Dialog>
  );
}
