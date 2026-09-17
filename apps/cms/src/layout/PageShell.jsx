// Standard page frame: title, optional description, optional action slot,
// and the content region. Every feature page renders through this so
// headings, spacing, and width stay consistent.
export function PageShell({ title, description, actions, children }) {
  return (
    <div className="page-shell">
      <div className="page-shell__header">
        <div>
          <h1 className="page-shell__title">{title}</h1>
          {description && <p className="page-shell__description">{description}</p>}
        </div>
        {actions && <div className="page-shell__actions">{actions}</div>}
      </div>
      <div className="page-shell__body">{children}</div>
    </div>
  );
}

export default PageShell;
