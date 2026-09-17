// WP-05b — small formatters for notification variables. Kept here (not a
// shared util) so notification copy formatting stays owned by this module.

const SYMBOL = { INR: '₹', USD: '$', EUR: '€', GBP: '£' };

/** Minor units -> a display string, e.g. (123400, 'INR') -> "₹1,234.00". */
export function formatMinor(minor, currency = 'INR') {
  const n = Number(minor || 0) / 100;
  const body = n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${SYMBOL[currency] || `${currency} `}${body}`;
}

/** Refund method code -> customer-facing phrase. */
export function refundMethodPhrase(method) {
  switch (method) {
    case 'ORIGINAL_PAYMENT': return 'your original payment method';
    case 'STORE_CREDIT': return 'CORCOTTON store credit';
    // A COD order has no original payment method — saying so would be wrong
    // and would confuse a customer who paid the courier in cash.
    case 'COD_PAYOUT': return 'the account you gave us';
    case 'COD_BLOCKED':
    case 'BLOCKED': return 'a method our team will confirm with you';
    default: return 'your original payment method';
  }
}
