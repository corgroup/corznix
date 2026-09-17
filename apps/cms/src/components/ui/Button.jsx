// The one CMS button. `className` is merged, never substituted: it used to be
// spread after the component's own class, so <Button className="ord-next">
// silently dropped `btn btn--secondary` and rendered a bare browser button.
export function Button({
  variant = 'primary',
  size,
  block = false,
  type = 'button',
  busy = false,
  disabled,
  className,
  children,
  ...rest
}) {
  const classes = [
    'btn',
    `btn--${variant}`,
    size === 'sm' && 'btn--sm',
    block && 'btn--block',
    className,
  ].filter(Boolean).join(' ');
  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy && <span className="btn__spinner" aria-hidden="true" />}
      {busy ? 'Working…' : children}
    </button>
  );
}

export default Button;
