// WP-07 — starter template content for each lifecycle policy.
//
// These are NOT auto-seeded. The CMS "Lifecycle notifications" panel offers a
// one-click "create draft from default" per policy/channel; a staff member
// reviews the copy, edits if needed (by creating a further version), and
// activates it. Nothing sends until a template is ACTIVE.
//
// EMAIL bodyTemplate is light HTML — only the {{variable}} VALUES are
// HTML-escaped at render time, the template markup itself passes through.
// WHATSAPP bodyTemplate is plain text and must mirror the wording of the
// provider-approved template whose name goes in providerTemplateRef (left
// blank here — the business supplies it).

export const TEMPLATE_DEFAULTS = {
  'payment.successful': {
    EMAIL: {
      subject: 'Payment received for order {{orderNumber}}',
      bodyTemplate:
        "<p>Hi {{customerName}},</p>"
        + "<p>We have received your payment of <strong>{{amount}}</strong> for order "
        + "<strong>{{orderNumber}}</strong> on {{paymentDate}}.</p>"
        + "<p>Your order is now confirmed and we will let you know as soon as it ships.</p>"
        + "<p>— The CORCOTTON team</p>",
    },
    WHATSAPP: {
      bodyTemplate: "Hi {{customerName}}, we have received your payment of {{amount}} for {{paymentReference}} on {{paymentDate}}. Your CORCOTTON order is confirmed.",
      providerTemplateRef: 'payment_successful',
    },
  },
  'order.placed': {
    EMAIL: {
      subject: "We've received your order {{orderNumber}}",
      bodyTemplate:
        "<p>Hi,</p>"
        + "<p>Thanks for shopping with CORCOTTON. We've received order <strong>{{orderNumber}}</strong> "
        + "and it's now being processed. We'll email you again as soon as it ships.</p>"
        + "<p>— The CORCOTTON team</p>",
    },
  },
  'order.confirmed': {
    EMAIL: {
      subject: 'Your order {{orderNumber}} is confirmed',
      bodyTemplate:
        "<p>Hi,</p>"
        + "<p>Order <strong>{{orderNumber}}</strong> is confirmed and moving to our warehouse for packing.</p>"
        + "<p>— The CORCOTTON team</p>",
    },
    WHATSAPP: {
      bodyTemplate: 'Your CORCOTTON order {{orderNumber}} is confirmed and moving to our warehouse for packing.',
      providerTemplateRef: 'order_management',
    },
  },
  'order.processing': {
    EMAIL: {
      subject: 'We are preparing order {{orderNumber}}',
      bodyTemplate:
        "<p>Hi,</p>"
        + "<p>Order <strong>{{orderNumber}}</strong> is being picked and packed at our warehouse right now.</p>"
        + "<p>We'll let you know the moment it is handed to our delivery partner.</p>"
        + "<p>— The CORCOTTON team</p>",
    },
    WHATSAPP: {
      bodyTemplate: "Hi {{customerName}}, we have received your order {{orderNumber}} and it is now being processed. We will notify you when it is ready for shipment.",
      providerTemplateRef: 'order_processing',
    },
  },
  'order.ready_for_shipment': {
    EMAIL: {
      subject: 'Order {{orderNumber}} is packed and ready to ship',
      bodyTemplate:
        "<p>Hi,</p>"
        + "<p>Order <strong>{{orderNumber}}</strong> is packed, labelled and waiting for our delivery partner to collect it.</p>"
        + "<p>You'll get a tracking number as soon as it is picked up.</p>"
        + "<p>— The CORCOTTON team</p>",
    },
    WHATSAPP: {
      bodyTemplate: "Hi {{customerName}}, your order {{orderNumber}} has been packed and is ready for shipment. We will send you the tracking details once it has been handed over to the delivery partner.",
      providerTemplateRef: 'order_ready_for_shipment',
    },
  },
  'order.shipped': {
    EMAIL: {
      subject: 'Your order {{orderNumber}} has shipped',
      bodyTemplate:
        "<p>Hi,</p>"
        + "<p>Good news — order <strong>{{orderNumber}}</strong> has shipped with {{carrier}}.</p>"
        + "<p>Tracking number (AWB): <strong>{{awb}}</strong></p>"
        + "<p>— The CORCOTTON team</p>",
    },
    WHATSAPP: {
      bodyTemplate: 'Your CORCOTTON order {{orderNumber}} has shipped with {{carrier}}. Track it with AWB {{awb}}.',
      providerTemplateRef: 'shipment_confirmation_1',
    },
  },
  'order.out_for_delivery': {
    EMAIL: {
      subject: 'Your order {{orderNumber}} is out for delivery',
      bodyTemplate:
        "<p>Hi,</p>"
        + "<p>Order <strong>{{orderNumber}}</strong> is out for delivery today (AWB {{awb}}). "
        + "Please keep your phone reachable for the delivery agent.</p>"
        + "<p>— The CORCOTTON team</p>",
    },
    WHATSAPP: {
      bodyTemplate: 'Your CORCOTTON order {{orderNumber}} is out for delivery today. AWB {{awb}}.',
      providerTemplateRef: 'track_order',
    },
  },
  'order.delivery_attempt_failed': {
    EMAIL: {
      subject: "We couldn't deliver order {{orderNumber}} today",
      bodyTemplate:
        "<p>Hi,</p>"
        + "<p>Our courier tried to deliver order <strong>{{orderNumber}}</strong> (AWB {{awb}}) today but couldn't complete it — {{reason}}.</p>"
        + "<p>We'll automatically try again. If your address or phone number needs correcting, please reply to this email or contact support so we can update the delivery.</p>"
        + "<p>— The CORCOTTON team</p>",
    },
    WHATSAPP: {
      bodyTemplate: "We couldn't deliver your CORCOTTON order {{orderNumber}} today ({{reason}}). We'll try again — reply here if your address needs updating.",
      providerTemplateRef: 'delivery_failed',
    },
  },
  'order.delivered': {
    EMAIL: {
      subject: 'Your order {{orderNumber}} has been delivered',
      bodyTemplate:
        "<p>Hi,</p>"
        + "<p>Order <strong>{{orderNumber}}</strong> has been delivered. We hope you love it.</p>"
        + "<p>Something not right? You can start a return or exchange from your account.</p>"
        + "<p>— The CORCOTTON team</p>",
    },
    WHATSAPP: {
      bodyTemplate: 'Your CORCOTTON order {{orderNumber}} has been delivered. We hope you love it.',
      providerTemplateRef: 'delivery_confirmation',
    },
  },
  'order.completed': {
    EMAIL: {
      subject: 'Order {{orderNumber}} complete',
      bodyTemplate:
        "<p>Hi,</p>"
        + "<p>Every item in order <strong>{{orderNumber}}</strong> has now been delivered. Thank you for shopping with CORCOTTON.</p>"
        + "<p>— The CORCOTTON team</p>",
    },
  },
  'order.cancelled': {
    EMAIL: {
      subject: 'Your order {{orderNumber}} has been cancelled',
      bodyTemplate:
        "<p>Hi,</p>"
        + "<p>Order <strong>{{orderNumber}}</strong> has been cancelled ({{reason}}). "
        + "Any payment made online will be refunded to your original payment method.</p>"
        + "<p>— The CORCOTTON team</p>",
    },
    WHATSAPP: {
      bodyTemplate: "Your CORCOTTON order {{orderNumber}} has been cancelled. Any online payment will be refunded to your original payment method.",
      providerTemplateRef: "order_canceled",
    },
  },

  // ---- WP-05b: returns + refunds ----------------------------------------
  'return.requested': {
    EMAIL: {
      subject: "We've received your return request {{requestNumber}}",
      bodyTemplate:
        "<p>Hi,</p>"
        + "<p>We've received return request <strong>{{requestNumber}}</strong> for order {{orderNumber}}. "
        + "Our team will review it and get back to you shortly.</p>"
        + "<p>— The CORCOTTON team</p>",
    },
  },
  'return.approved': {
    EMAIL: {
      subject: 'Your return {{requestNumber}} is approved',
      bodyTemplate:
        "<p>Hi,</p>"
        + "<p>Return <strong>{{requestNumber}}</strong> (order {{orderNumber}}) has been approved. "
        + "We'll arrange a pickup and email you the details.</p>"
        + "<p>— The CORCOTTON team</p>",
    },
  },
  'return.rejected': {
    EMAIL: {
      subject: 'Update on your return request {{requestNumber}}',
      bodyTemplate:
        "<p>Hi,</p>"
        + "<p>We're sorry — return request <strong>{{requestNumber}}</strong> for order {{orderNumber}} "
        + "could not be approved ({{reason}}). If you think this is a mistake, please reply to this email "
        + "or contact support.</p>"
        + "<p>— The CORCOTTON team</p>",
    },
  },
  'return.received': {
    EMAIL: {
      subject: "We've received your returned item ({{requestNumber}})",
      bodyTemplate:
        "<p>Hi,</p>"
        + "<p>Your returned item for request <strong>{{requestNumber}}</strong> (order {{orderNumber}}) "
        + "has arrived at our warehouse and is being inspected. We'll email you once your refund is on its way.</p>"
        + "<p>— The CORCOTTON team</p>",
    },
    WHATSAPP: {
      bodyTemplate: "We have received your CORCOTTON return for order {{orderNumber}}. Your {{resolutionType}} of {{amount}} is being processed.",
      providerTemplateRef: "return_confirmation",
    },
  },
  'refund.initiated': {
    EMAIL: {
      subject: 'Your refund for {{requestNumber}} is on its way',
      bodyTemplate:
        "<p>Hi,</p>"
        + "<p>A refund of <strong>{{amount}}</strong> for return {{requestNumber}} (order {{orderNumber}}) "
        + "has been initiated to {{method}}. It can take a few business days to appear.</p>"
        + "<p>— The CORCOTTON team</p>",
    },
  },
  'refund.completed': {
    EMAIL: {
      subject: 'Your refund for {{requestNumber}} is complete',
      bodyTemplate:
        "<p>Hi,</p>"
        + "<p>Your refund of <strong>{{amount}}</strong> for return {{requestNumber}} (order {{orderNumber}}) "
        + "has been completed to {{method}}.</p>"
        + "<p>— The CORCOTTON team</p>",
    },
    WHATSAPP: {
      bodyTemplate: "Your CORCOTTON refund of {{amount}} for order {{orderNumber}} has been completed.",
      providerTemplateRef: "refund_confirmation",
    },
  },
  'refund.failed': {
    EMAIL: {
      subject: 'We could not complete your refund for {{requestNumber}}',
      bodyTemplate:
        "<p>Hi,</p>"
        + "<p>We tried to send your refund of <strong>{{amount}}</strong> for return {{requestNumber}} "
        + "(order {{orderNumber}}) to {{method}}, but the transfer did not go through.</p>"
        + "<p>This usually means the account details need a small correction. "
        + "Please reply to this email or contact us and we will get it sorted — "
        + "your refund has not been cancelled.</p>"
        + "<p>— The CORCOTTON team</p>",
    },
  },
  'account.welcome': {
    EMAIL: {
      subject: 'Welcome to CORCOTTON',
      bodyTemplate:
        "<p>Hi {{customerName}},</p>"
        + "<p>Your CORCOTTON account is ready. You can follow your orders, download invoices, "
        + "save addresses and see your store credit in one place — sign in any time with your "
        + "mobile number or email; there is no password to remember.</p>"
        + "<p>Thank you for choosing cotton that is gentler on skin and on the earth.</p>"
        + "<p>— The CORCOTTON team</p>",
    },
  },
  'payment.failed': {
    EMAIL: {
      subject: 'Your payment did not go through',
      bodyTemplate:
        "<p>Hi,</p>"
        + "<p>Your payment of <strong>{{amount}}</strong> was not completed — {{reason}}. "
        + "<strong>No money has been taken</strong> and no order was placed.</p>"
        + "<p>Your bag is exactly as you left it, so you can try again whenever you are ready, "
        + "with the same payment method or a different one.</p>"
        + "<p>— The CORCOTTON team</p>",
    },
  },
  'store_credit.granted': {
    EMAIL: {
      subject: 'Store credit added to your CORCOTTON account',
      bodyTemplate:
        "<p>Hi,</p>"
        + "<p><strong>{{amount}}</strong> of store credit has been added to your account for {{reason}}. "
        + "Your balance is now <strong>{{balance}}</strong>.</p>"
        + "<p>You can use it at checkout on your next order — it is applied before payment, "
        + "so you only pay the difference.</p>"
        + "<p>— The CORCOTTON team</p>",
    },
  },
};
