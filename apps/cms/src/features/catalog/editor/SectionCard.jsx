// A titled white card that groups one product-setup concern. `status` renders
// a small semantic badge (Complete / Needs attention / Optional / …); it is
// derived from real product data by the editor, never faked.
//
// Class prefix is `editor-card` (not the shared `section-card`, which the
// dashboard already owns) — the two must not collide in the global stylesheet.
export function SectionCard({ id, title, description, status, children }) {
  return (
    <section className="editor-card" id={id}>
      <header className="editor-card__head">
        <div>
          <h2 className="editor-card__title">{title}</h2>
          {description && <p className="editor-card__desc">{description}</p>}
        </div>
        {status && <span className={`editor-card__status editor-card__status--${status.tone}`}>{status.label}</span>}
      </header>
      <div className="editor-card__body">{children}</div>
    </section>
  );
}

export default SectionCard;
