import { useEffect, useRef, useState } from 'react';

// Compact "···" row-actions popover. Children are the menu items (buttons or
// links); each is closed on click. Used across the catalog list workbenches.
export function RowMenu({ label = 'Row actions', children, align = 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={`row-menu row-menu--${align}`} ref={ref}>
      <button
        type="button"
        className="row-menu__trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
        </svg>
      </button>
      {open && (
        <div
          className="row-menu__panel"
          role="menu"
          onClick={(e) => { e.stopPropagation(); setOpen(false); }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export default RowMenu;
