// Default copy + canonical variable schema for abandoned-cart reminders.
//
// These are MARKETING templates (consent + suppression are re-checked at the
// send boundary by the communications engine, exactly like a broadcast). The
// EMAIL default is seeded ACTIVE; the WhatsApp default is seeded DRAFT because
// it needs an Infyntra-approved provider template name before it can send.
//
// A campaign points at a template by key. The operator may edit the copy in
// CMS → Marketing → Message Templates (each edit is a new version to activate).

export const ABANDONED_CART_TEMPLATE_KEYS = Object.freeze({
  EMAIL: 'marketing.abandoned_cart',
  WHATSAPP: 'marketing.abandoned_cart',
});

// Every placeholder the service can supply. `couponLine` is a whole sentence
// ("" when the campaign has no coupon) so the copy never renders a dangling
// "use code" with a blank code.
export const ABANDONED_CART_VARIABLE_SCHEMA = Object.freeze({
  itemCount: { required: true, type: 'number' },
  cartValue: { required: true, type: 'string' },
  firstItemName: { required: true, type: 'string' },
  couponLine: { type: 'string' },
  cartUrl: { required: true, type: 'string' },
  // Everything below is resolved from THIS customer's own abandoned cart on
  // every send. None of it has a default and none of it is shared between
  // recipients — that is what stops one customer seeing another's product.
  customerName: { required: true, type: 'string' },
  productImageUrl: { type: 'string' },
  productName: { required: true, type: 'string' },
  variantLabel: { type: 'string' },
  quantity: { required: true, type: 'number' },
  // The dynamic-URL button on the approved Meta template appends this suffix
  // to its base; the email links to the whole URL. Both are per-customer.
  recoveryUrlSuffix: { required: true, type: 'string' },
});

export const ABANDONED_CART_TEMPLATE_DEFAULTS = Object.freeze({
  EMAIL: {
    subject: 'Still thinking about it?',
    bodyTemplate:
      '<p>Hi {{customerName}},</p>'
      + '<p>You left <strong>{{itemCount}}</strong> item(s) in your CORCOTTON cart — '
      + 'that\'s <strong>{{cartValue}}</strong> waiting for you.</p>'
      // The customer's own abandoned product, not a generic hero image. The
      // service only sets productImageUrl when the product actually has an
      // ACTIVE IMAGE row, so this never renders a broken image.
      + '<p><img src="{{productImageUrl}}" alt="{{productName}}" width="260" '
      + 'style="max-width:100%;border-radius:8px;display:block" /></p>'
      + '<p><strong>{{productName}}</strong><br />{{variantLabel}}<br />Quantity: {{quantity}}</p>'
      + '<p>{{couponLine}}</p>'
      + '<p><a href="{{cartUrl}}">Return to your cart</a> to finish checking out.</p>'
      + '<p>— The CORCOTTON team</p>',
  },
  WHATSAPP: {
    // Mirrors the approved Meta template's wording. The image header and the
    // Return to Cart button are supplied as template components by the
    // provider adapter, not from this body.
    bodyTemplate:
      'Hey {{customerName}}, your selected CORCOTTON pieces are still in your cart. '
      + 'If you\'re ready, you can pick up right where you left off and complete your order.',
    providerTemplateRef: 'corcotton_abandoned_cart',
  },
});
