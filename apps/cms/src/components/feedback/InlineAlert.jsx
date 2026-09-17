export function InlineAlert({ tone = 'error', children }) {
  if (!children) return null;
  return (
    <p className={`inline-alert inline-alert--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </p>
  );
}

export default InlineAlert;
