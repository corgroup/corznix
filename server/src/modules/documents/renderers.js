import { buildPdf } from '../../platform/pdf/miniPdf.js';
import { buildInvoicePdf } from './invoicePdf.js';

// Renderers turn an immutable document snapshot into artefact bytes. They read
// ONLY the snapshot — never live product / warehouse / company rows.
const rupees = (minor) => `INR ${(Number(minor || 0) / 100).toFixed(2)}`;
const addr = (a) => (a ? [a.name, a.addressLine1, a.addressLine2, [a.city, a.state, a.postalCode].filter(Boolean).join(' '), a.country].filter(Boolean) : []);

// The customer-facing tax invoice is a designed layout (invoicePdf.js); the
// internal documents below stay plain text.
async function renderInvoice(s, { images } = {}) {
  return { bytes: await buildInvoicePdf(s, { images }), format: 'A4_PDF', ext: 'pdf' };
}

function renderPackingSlip(s) {
  const lines = [
    { text: 'PACKING SLIP — INTERNAL', size: 15, bold: true },
    { text: `Fulfilment: ${s.fulfillmentNumber}    Order: ${s.orderId}`, gap: 16 },
    { text: `Dispatch from: ${s.dispatchFrom?.name || '—'}` },
    { text: 'Ship to', bold: true },
    ...addr(s.shipTo).map((t) => ({ text: t })),
    { text: 'Items', bold: true, gap: 16 },
    ...s.items.map((i) => ({ text: `[ ] ${i.quantity} x ${i.name}  ${[i.color, i.size].filter(Boolean).join(' / ')}  (${i.sku})` })),
  ];
  return { bytes: buildPdf({ pageSize: 'A4', lines }), format: 'A4_PDF', ext: 'pdf' };
}

function renderShippingLabel(s) {
  const lines = [
    { text: 'MOCK / TEST LABEL', size: 13, bold: true },
    { text: `Shipment: ${s.shipmentNumber}` },
    { text: `AWB: ${s.awbNumber}  (${s.providerCode})`, bold: true, gap: 14 },
    { text: 'FROM', bold: true, size: 8 },
    { text: s.dispatchFrom?.name || '—', size: 8 },
    ...addr(s.dispatchFrom?.address).map((t) => ({ text: t, size: 8 })),
    { text: 'TO', bold: true, size: 8 },
    ...addr(s.shipTo).map((t) => ({ text: t, size: 8 })),
    { text: s.codCollectionMinor > 0 ? `COD ${rupees(s.codCollectionMinor)}` : 'PREPAID', bold: true },
  ];
  return { bytes: buildPdf({ pageSize: 'LABEL_4X6', lines }), format: 'PDF4X6', ext: 'pdf' };
}

function renderCreditNote(s) {
  const lines = [
    { text: 'CREDIT NOTE', size: 16, bold: true },
    { text: `Credit Note No: ${s.creditNoteNumber}    Against Invoice: ${s.invoiceNumber}`, gap: 16 },
    { text: `Date: ${new Date(s.issuedAt).toISOString().slice(0, 10)}` },
    { text: `Amount: ${rupees(s.amountMinor)}`, bold: true },
    { text: `Reason: ${s.reason || '—'}` },
    { text: s.treatmentPending ? 'GST reversal treatment: PENDING CONFIGURATION' : '' },
  ];
  return { bytes: buildPdf({ pageSize: 'A4', lines }), format: 'A4_PDF', ext: 'pdf' };
}

const RENDERERS = {
  INVOICE: renderInvoice,
  PACKING_SLIP: renderPackingSlip,
  SHIPPING_LABEL: renderShippingLabel,
  CREDIT_NOTE: renderCreditNote,
};

/** @returns {Promise<{ bytes: Buffer, format: string, ext: string }>} */
export async function renderDocument(type, snapshot, options = {}) {
  const fn = RENDERERS[type];
  if (!fn) { const e = new Error(`No renderer for ${type}`); e.code = 'DOCUMENT_RENDER_FAILED'; throw e; }
  if (snapshot?.__forceRenderFailure) { const e = new Error('Injected render failure'); e.code = 'DOCUMENT_RENDER_FAILED'; throw e; }
  return fn(snapshot, options);
}
