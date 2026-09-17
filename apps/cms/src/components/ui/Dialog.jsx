import { useEffect, useRef } from 'react';

// Lightweight modal dialog. Focus is moved into the panel on open, Escape
// closes, and a click on the backdrop closes. No portal — it renders a
// fixed-position overlay in place, which is enough for the CMS shell.
export function Dialog({ open, onClose, title, children, actions, dismissible = true }) {
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const prev = document.activeElement;
    panelRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape' && dismissible) onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (prev instanceof HTMLElement) prev.focus();
    };
  }, [open, onClose, dismissible]);

  if (!open) return null;

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => { if (dismissible && e.target === e.currentTarget) onClose?.(); }}
    >
      <div
        className="dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panelRef}
      >
        {title && <h2 className="dialog-panel__title">{title}</h2>}
        <div className="dialog-panel__body">{children}</div>
        {actions && <div className="dialog-panel__actions">{actions}</div>}
      </div>
    </div>
  );
}

export default Dialog;
