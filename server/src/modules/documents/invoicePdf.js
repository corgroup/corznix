import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { rupeesInWords } from '../../utils/amountInWords.js';

// The customer-facing GST tax invoice, laid out to the approved design: brand
// header, supplier / dispatch / bill-to panels, an items table with product
// thumbnails, the order summary beside a thank-you panel, and a brand footer.
//
// It reads ONLY the immutable invoice snapshot (plus thumbnail bytes loaded for
// the render). Noto Sans is embedded so the rupee sign and product names print
// exactly; the standard PDF fonts have neither.

const FONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../assets/fonts');
const FONT = { regular: path.join(FONT_DIR, 'NotoSans-Regular.ttf'), bold: path.join(FONT_DIR, 'NotoSans-Bold.ttf') };

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 36;
const CW = PAGE_W - M * 2;
const C = { ink: '#0B0B0C', muted: '#6B6F76', faint: '#9A9EA5', line: '#E4E4E0', panel: '#F6F6F3', greenBg: '#E5F3E9', green: '#1D7A3A', white: '#FFFFFF' };
const SUPPORT_EMAIL = 'support@corcotton.in';
const WEBSITE = 'www.corcotton.in';

// CORCOTTON wordmark (apps/corcotton/src/assets/icons/Logo.jsx), viewBox 500 425 1010 150.
const LOGO = {
  viewBox: [500, 425, 1010, 150],
  paths: [
    'M1307.43,563.3c-19.92-3.85-33.73-17.14-38.71-38.1-5.24-22.06-3.99-52.02,10.69-69.29,15.46-18.19,45.6-20.35,67.37-16.170,8.26,1.59,15.75,4.58,22.59,9.66,20.63,15.33,23.31,49.55,17.49,74.82-2.09,9.070-5.74,17.37-11.85,23.95-7.49,8.07-17.14,13.03-27.61,15.12-13.22,2.63-26.4,2.64-39.97.02ZM1343.5,540.31c1.95-7.29,3.27-14.56,3.26-22.2l-.03-35.72c0-7.05-1.37-13.84-3.1-20.47-2.03-7.83-8.01-12.36-15.47-12.24-4.91.08-10.06,1.17-13.2,5.64-3.27,4.66-4.79,10.47-5.54,16.51-2.43,19.61-2.37,39.27-.24,58.94.59,5.5,2.05,10.55,4.42,15.18,2.23,4.35,6.14,6.66,10.61,7.13,9.72,1.04,16.53-2.39,19.3-12.75Z',
    'M1499.99,440.65L1468.24,440.58L1431.3,490.44L1410.17,518.4L1410.07,440.63L1394.05,440.63L1394.03,562.85L1426.44,562.99L1464.88,508.36L1484.78,481.42L1484.82,562.73L1500,562.93Z',
    'M1165.71,559.73L1123.36,559.76L1123.35,451.71L1094.41,451.33L1094.47,437.08L1185.37,437.04L1185.39,451.28L1165.72,451.75Z',
    'M1206.61,559.73L1248.95,559.76L1248.96,451.71L1277.9,451.33L1277.84,437.08L1186.94,437.04L1186.92,451.28L1206.59,451.75Z',
    'M1101.79,525.57c-5.62,19.1-20.87,31.36-38.75,34.66-13.24,2.45-26.54,2.44-39.76-.19-9.37-1.86-17.88-6.05-24.87-12.96-17.5-17.3-18.97-53.51-11.81-77.47,3.58-11.98,10.85-21.29,21.09-26.79,14.88-8,33.01-9.25,49.54-7.22,10.45,1.28,20.2,4.78,28.83,11.14,13.74,10.13,18.85,28.34,19.42,46.05.37,11.32-.55,22.09-3.69,32.78ZM1054.29,546.44c3.64-3.42,5.32-8.5,6.29-13.41,3.69-18.57,3.54-46.96.9-65.99-1.53-11.01-5.52-19.72-16.05-20.49-5.4-.39-11.33.89-14.65,5.87-3.26,4.88-4.43,10.9-5.15,17.01-2.23,18.89-2.12,37.740-.23,56.72.52,5.24,1.71,10.19,3.5,14.78,4.35,11.13,19.34,11.18,25.38,5.5Z',
    'M927.41,549.64c15.68-.03,18.5-15.22,18.3-31.07l36.37-.02c-.47,6.21-1.81,12.07-4.12,17.78-11.2,27.65-51.49,28.58-76.21,22.81-8.73-2.04-16.58-5.85-23.15-12.27-14.15-13.82-16.87-37.68-15.36-57.96.95-12.76,4.9-24.82,12.63-34.48,15.53-19.43,48.18-21.4,70.74-16.86,6.94,1.4,13.32,4.1,19.04,8.34,10.6,7.87,13.9,20.34,14.57,33.98l-34.46-.02c.02-7.010-.31-13.4-1.94-19.84-2.11-8.33-8.64-13.41-16.6-12.84-7.69-.43-14.05,4.21-16.79,12.02-2.6,7.43-3.9,15.19-4.33,23.34-.9,17.06-.98,38.95,4.06,54.38,2.7,8.26,8.91,13.47,17.27,12.71Z',
    'M746.45,559.95h40.95c.03-3.4.11-6.87.22-10.4.14-4.25.34-8.41.59-12.46.39-5.41.77-10.82,1.16-16.22.03-9.41,5.31-18.29,14.42-18.29h13.77s.05,57.34.05,57.34h40.27s-.01-122.34-.01-122.34l-66.45.11c-7.19.01-13.83,1.78-20.68,3.17-15.23,4.69-28.02,13.42-27.06,31.05.4,7.26,4.36,14,10.28,18.66,5.66,4.45,12.06,6.39,19.33,8.37l-13.7,5.82c-5.66,3.25-9.69,8.77-10.5,15.73-.41,5.73-.82,11.47-1.23,17.2-.1,1.7-.27,4.29-.53,7.48-.24,2.9-.38,3.98-.53,6.05-.16,2.07-.33,5.06-.36,8.74ZM791.08,453.94c3.78-2.07,8.07-3.5,12.43-3.51h13.76s-.02,40.14-.02,40.14l-15.45-.19c-4.62-.06-9.32-2.01-12.54-5.43-6.85-7.28-7.1-24.76,1.82-31.03Z',
    'M730.81,544.27c-16.42,18.51-43.73,19.93-66.38,16.27-17.74-2.87-32.69-13.49-38.69-32.19-6.07-18.94-6.24-39.58-.38-58.55,6.82-22.05,23.71-31.2,44.17-33.99s44.5-.41,59.57,14.49c6.25,6.18,10.33,14.05,12.6,23.05,5.58,22.18,4.2,53.9-10.89,70.92ZM691.25,547.93c6.89-3.96,9.17-15.4,10.03-24.14,1.7-17.33,1.76-34.46.1-51.79-1.35-14.11-5.01-25.59-18.54-25.61-7.63,0-13.87,4.3-15.96,12.45-4.64,18.03-4.58,42.02-3.13,61.09.75,9.87,2.59,23.53,9.9,27.84,5.27,3.11,12.06,3.33,17.6.15Z',
    'M546.7,536.06c3.81,12.89,14.57,16.23,26.16,12.16,4.46-2.71,6.93-7.07,8.52-12.23,1.2-5.69,1.69-11.22,1.79-17.43h36.13c-.15,23.86-15.76,37.7-36.6,41.66-15.17,2.88-30.49,2.27-45.45-1.5-16.84-4.24-29.51-17.17-34.17-35.33-3.61-14.07-4-28.96-1.33-43.38,3.81-20.59,16.42-35.7,35.29-40.95,20.01-5.56,49.12-5.73,66.43,7,10.25,7.54,14.35,20.57,14.72,33.83l-35.030-.03c-.3-11.72-.35-25.33-9.58-30.93-10.29-4.29-22-1.59-26.13,9.8-2.12,5.82-3.33,11.87-3.88,18.19-1.55,17.91-1.77,42.51,3.15,59.15Z',
  ],
};

const rupee = (minor) => `₹ ${(Number(minor || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (bps) => `${(Number(bps || 0) / 100).toFixed(2)}%`;
const formatDate = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const personName = (a) => (a ? a.name || [a.firstName, a.lastName].filter(Boolean).join(' ') : '');
// City, state and PIN share one line (and India is implied) so the address
// panels stay short enough for a two-item invoice to fit on one page.
const addressLines = (a) => (a ? [
  a.addressLine1, a.addressLine2,
  [[a.city, a.district && a.district !== a.city ? a.district : null].filter(Boolean).join(', '), [a.state, a.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', '),
  a.country && !['IN', 'India'].includes(a.country) ? a.country : null,
].filter(Boolean) : []);

function drawLogo(doc, x, y, width, color = C.ink) {
  const [vx, vy, vw] = LOGO.viewBox;
  const scale = width / vw;
  doc.save();
  doc.translate(x, y).scale(scale).translate(-vx, -vy);
  for (const d of LOGO.paths) doc.path(d).fill(color);
  doc.restore();
}

function labelText(doc, text, x, y, opts = {}) {
  doc.font('bold').fontSize(7).fillColor(C.muted).text(text.toUpperCase(), x, y, { characterSpacing: 0.8, lineBreak: false, ...opts });
}

// Measure, then draw a filled panel of the needed height with its lines.
function panel(doc, { x, y, w, label, lines, fill = C.panel, minHeight = 0, right = null }) {
  const pad = 12;
  const innerW = w - pad * 2 - (right ? right.width + 10 : 0);
  const heights = lines.map((l) => {
    doc.font(l.bold ? 'bold' : 'regular').fontSize(l.size || 8.5);
    return doc.heightOfString(l.text, { width: innerW }) + (l.gap ?? 1);
  });
  const h = Math.max(minHeight, pad + 12 + heights.reduce((s, v) => s + v, 0) + pad - 2);
  doc.roundedRect(x, y, w, h, 6).fill(fill);
  labelText(doc, label, x + pad, y + pad);
  let cy = y + pad + 12;
  lines.forEach((l, i) => {
    doc.font(l.bold ? 'bold' : 'regular').fontSize(l.size || 8.5).fillColor(l.color || C.ink).text(l.text, x + pad, cy, { width: innerW });
    cy += heights[i];
  });
  if (right) right.draw(x + w - pad - right.width, y + pad);
  return h;
}

// Small line icons for the thank-you panel.
const ICONS = {
  leaf(doc, cx, cy) {
    doc.save().lineWidth(1.1).strokeColor(C.ink);
    doc.moveTo(cx - 8, cy + 8).bezierCurveTo(cx - 9, cy - 4, cx + 1, cy - 10, cx + 9, cy - 9).bezierCurveTo(cx + 9, cy + 1, cx + 2, cy + 9, cx - 8, cy + 8).stroke();
    doc.moveTo(cx - 8, cy + 8).lineTo(cx + 3, cy - 3).stroke();
    doc.restore();
  },
  box(doc, cx, cy) {
    doc.save().lineWidth(1.1).strokeColor(C.ink).lineJoin('round');
    doc.polygon([cx, cy - 9], [cx + 9, cy - 4.5], [cx + 9, cy + 5.5], [cx, cy + 10], [cx - 9, cy + 5.5], [cx - 9, cy - 4.5]).stroke();
    doc.moveTo(cx - 9, cy - 4.5).lineTo(cx, cy).lineTo(cx + 9, cy - 4.5).stroke();
    doc.moveTo(cx, cy).lineTo(cx, cy + 10).stroke();
    doc.restore();
  },
  heart(doc, cx, cy) {
    doc.save().lineWidth(1.1).strokeColor(C.ink);
    doc.moveTo(cx, cy + 8).bezierCurveTo(cx - 12, cy, cx - 10, cy - 10, cx, cy - 4).bezierCurveTo(cx + 10, cy - 10, cx + 12, cy, cx, cy + 8).stroke();
    doc.restore();
  },
  person(doc, cx, cy) {
    doc.save().lineWidth(1.1).strokeColor(C.ink);
    doc.circle(cx, cy - 4, 4.5).stroke();
    doc.moveTo(cx - 8, cy + 9).bezierCurveTo(cx - 8, cy + 2, cx + 8, cy + 2, cx + 8, cy + 9).stroke();
    doc.restore();
  },
};

const COLS = [
  { key: 'n', label: '#', w: 22, align: 'center' },
  { key: 'item', label: 'Item', w: 0, align: 'left' },
  { key: 'hsn', label: 'HSN', w: 44, align: 'center' },
  { key: 'gst', label: 'GST', w: 44, align: 'center' },
  { key: 'qty', label: 'Qty', w: 36, align: 'center' },
  { key: 'unit', label: 'Unit price', w: 70, align: 'right' },
  { key: 'total', label: 'Total', w: 72, align: 'right' },
];
COLS[1].w = CW - COLS.reduce((s, c) => s + c.w, 0);
// The narrow "#" column gets less padding, or "10" wrapped onto two lines.
const padX = (col) => (col.key === 'n' ? 2 : 8);

function drawTableHeader(doc, y) {
  doc.rect(M, y, CW, 24).fill(C.white);
  doc.lineWidth(0.8).strokeColor(C.line).roundedRect(M, y, CW, 24, 4).stroke();
  let x = M;
  for (const col of COLS) {
    doc.font('bold').fontSize(7.5).fillColor(C.ink).text(col.label.toUpperCase(), x + padX(col), y + 8, { width: col.w - padX(col) * 2, align: col.align, lineBreak: false, characterSpacing: 0.4 });
    x += col.w;
  }
  return y + 24;
}

const THUMB = 34;
const itemTextWidth = () => COLS[1].w - (THUMB + 26);
const itemMeta = (it) => [[it.color, it.size].filter(Boolean).join(' / '), it.sku].filter(Boolean).join('  |  ');

// Rows grow with the product name, so the page-break decision needs the real
// height: a fixed allowance let a four-line row run over the page footer.
function measureItemRow(doc, it) {
  const textW = itemTextWidth();
  const meta = itemMeta(it);
  doc.font('regular').fontSize(9);
  const nameH = doc.heightOfString(it.productName, { width: textW });
  doc.font('regular').fontSize(7.5);
  const metaH = meta ? doc.heightOfString(meta, { width: textW }) : 0;
  return { h: Math.max(46, nameH + metaH + 18), nameH, metaH, meta, textW };
}

function drawItemRow(doc, y, index, it, images) {
  const thumb = THUMB;
  const textX = M + COLS[0].w + 8 + thumb + 10;
  const { h, nameH, metaH, meta, textW } = measureItemRow(doc, it);

  doc.lineWidth(0.8).strokeColor(C.line);
  doc.rect(M, y, CW, h).stroke();
  let x = M;
  for (const col of COLS.slice(0, -1)) { x += col.w; doc.moveTo(x, y).lineTo(x, y + h).stroke(); }

  const mid = y + h / 2 - 5;
  const cell = (key, text, font = 'regular', size = 9) => {
    let cx = M;
    for (const col of COLS) {
      if (col.key === key) { doc.font(font).fontSize(size).fillColor(C.ink).text(text, cx + padX(col), mid, { width: col.w - padX(col) * 2, align: col.align, lineBreak: false }); return; }
      cx += col.w;
    }
  };
  cell('n', String(index + 1));

  const tx = M + COLS[0].w + 8;
  const ty = y + (h - thumb) / 2;
  const img = it.imageUrl ? images.get(it.imageUrl) : null;
  doc.roundedRect(tx, ty, thumb, thumb, 4).fill(C.panel);
  if (img) {
    try { doc.image(img, tx, ty, { fit: [thumb, thumb], align: 'center', valign: 'center' }); } catch { /* undecodable image: keep the placeholder */ }
  }
  const textTop = y + (h - nameH - metaH - 2) / 2;
  doc.font('regular').fontSize(9).fillColor(C.ink).text(it.productName, textX, textTop, { width: textW });
  if (meta) doc.font('regular').fontSize(7.5).fillColor(C.muted).text(meta, textX, textTop + nameH + 2, { width: textW });

  cell('hsn', it.hsn || '—');
  cell('gst', it.gstRateBps != null ? pct(it.gstRateBps) : '—');
  cell('qty', String(it.quantity));
  cell('unit', rupee(it.unitPriceMinor));
  cell('total', rupee(it.totalMinor));
  return y + h;
}

function taxLabels(s) {
  const rates = [...new Set((s.items || []).map((i) => Number(i.gstRateBps)).filter((r) => Number.isFinite(r) && r > 0))];
  const single = rates.length === 1 ? rates[0] : null;
  return {
    cgst: single != null ? `CGST (${pct(single / 2)})` : 'CGST',
    sgst: single != null ? `SGST (${pct(single / 2)})` : 'SGST',
    igst: single != null ? `IGST (${pct(single)})` : 'IGST',
  };
}

function summaryRows(s) {
  const a = s.amounts || {};
  const inclusive = a.pricesIncludeTax === true;
  const intra = Number(a.cgstMinor) > 0 || Number(a.sgstMinor) > 0;
  const labels = taxLabels(s);
  return [
    [inclusive ? 'Subtotal (incl. GST)' : 'Subtotal', rupee(a.subtotalMinor)],
    ...(Number(a.discountMinor) > 0 ? [['Discount', `- ${rupee(a.discountMinor)}`]] : []),
    ['Taxable value', rupee(a.taxableMinor)],
    ...(intra
      ? [[`${labels.cgst}${inclusive ? ' incl.' : ''}`, rupee(a.cgstMinor)], [`${labels.sgst}${inclusive ? ' incl.' : ''}`, rupee(a.sgstMinor)]]
      : [[`${labels.igst}${inclusive ? ' incl.' : ''}`, rupee(a.igstMinor)]]),
    ['Shipping', rupee(a.shippingMinor)],
  ];
}

const SUMMARY_PAD = 12;
const amountWords = (s) => `Amount in words: ${rupeesInWords(s.amounts?.grandTotalMinor)}`;

// Measured before drawing, so the page break is decided on the real height.
function summaryHeight(doc, s, w) {
  doc.font('regular').fontSize(7.5);
  const wordsH = doc.heightOfString(amountWords(s), { width: w - SUMMARY_PAD * 2 });
  return SUMMARY_PAD + 18 + summaryRows(s).length * 15 + 4 + 36 + 28 + wordsH + SUMMARY_PAD;
}

function drawSummary(doc, s, x, y, w) {
  const a = s.amounts || {};
  const rows = summaryRows(s);
  const pad = SUMMARY_PAD;
  const words = amountWords(s);
  const h = summaryHeight(doc, s, w);
  doc.lineWidth(0.8).strokeColor(C.line).roundedRect(x, y, w, h, 6).stroke();

  let cy = y + pad;
  doc.font('bold').fontSize(10.5).fillColor(C.ink).text('Order Summary', x + pad, cy);
  cy += 18;
  for (const [label, value] of rows) {
    doc.font('regular').fontSize(8.5).fillColor(C.muted).text(label, x + pad, cy, { width: w * 0.6, lineBreak: false });
    doc.font('regular').fontSize(8.5).fillColor(C.ink).text(value, x + pad, cy, { width: w - pad * 2, align: 'right', lineBreak: false });
    cy += 15;
  }
  cy += 4;
  doc.roundedRect(x + 8, cy, w - 16, 30, 5).fill(C.panel);
  doc.font('bold').fontSize(10).fillColor(C.ink).text('GRAND TOTAL', x + pad + 4, cy + 9, { lineBreak: false });
  doc.font('bold').fontSize(13).fillColor(C.ink).text(rupee(a.grandTotalMinor), x + pad, cy + 6, { width: w - pad * 2 - 2, align: 'right', lineBreak: false });
  cy += 36;
  doc.roundedRect(x + 8, cy, w - 16, 22, 5).fill(C.greenBg);
  const paid = [`Paid online: ${rupee(a.onlinePaidMinor)}`, `Due on delivery: ${rupee(a.codDueMinor)}`,
    Number(a.exchangeCreditMinor) > 0 ? `Exchange credit: ${rupee(a.exchangeCreditMinor)}` : null].filter(Boolean).join('   |   ');
  doc.font('regular').fontSize(8).fillColor(C.green).text(paid, x + pad + 4, cy + 6, { width: w - pad * 2 - 4, lineBreak: false });
  cy += 28;
  doc.font('regular').fontSize(7.5).fillColor(C.muted).text(words, x + pad, cy, { width: w - pad * 2 });
  return h;
}

function drawThankYou(doc, x, y, w, h) {
  const pad = 16;
  doc.roundedRect(x, y, w, h, 6).fill(C.panel);
  doc.circle(x + pad + 13, y + pad + 13, 13).fill(C.greenBg);
  ICONS.leaf(doc, x + pad + 13, y + pad + 13);
  // Measured: the title wraps on a half-width panel and used to overprint the
  // line below it.
  const textW = w - pad * 2 - 34;
  const title = 'Thank you for shopping with CORCOTTON';
  doc.font('bold').fontSize(10);
  const titleH = doc.heightOfString(title, { width: textW });
  doc.fillColor(C.ink).text(title, x + pad + 34, y + pad + 2, { width: textW });
  doc.font('regular').fontSize(8).fillColor(C.muted).text('Sustainable clothing for a better tomorrow.', x + pad + 34, y + pad + 4 + titleH, { width: textW });

  const features = [['leaf', 'Premium\nQuality'], ['box', 'Sustainable\nFashion'], ['heart', 'Made\nResponsibly'], ['person', 'For a\nBrighter Future']];
  const colW = (w - pad * 2) / features.length;
  const iy = y + pad + titleH + 44;
  features.forEach(([icon, label], i) => {
    const cx = x + pad + colW * i + colW / 2;
    ICONS[icon](doc, cx, iy);
    doc.font('regular').fontSize(7.5).fillColor(C.ink).text(label, cx - colW / 2, iy + 16, { width: colW, align: 'center' });
    if (i > 0) doc.lineWidth(0.6).strokeColor(C.line).moveTo(x + pad + colW * i, iy - 12).lineTo(x + pad + colW * i, iy + 38).stroke();
  });
  const fy = y + h - pad - 30;
  doc.lineWidth(0.6).strokeColor(C.line).moveTo(x + pad, fy - 8).lineTo(x + w - pad, fy - 8).stroke();
  doc.font('bold').fontSize(8).fillColor(C.ink).text('Need help with your order?', x + pad, fy, { width: w - pad * 2, align: 'center' });
  doc.font('regular').fontSize(7.5).fillColor(C.muted).text(`Write to us at ${SUPPORT_EMAIL} or visit ${WEBSITE}`, x + pad, fy + 13, { width: w - pad * 2, align: 'center' });
}

function drawHeader(doc, s) {
  drawLogo(doc, M, 40, 170);
  doc.font('regular').fontSize(6.5).fillColor(C.ink).text('BUILD WITH PURPOSE', M + 14, 70, { characterSpacing: 2.4, lineBreak: false });
  doc.font('regular').fontSize(8).fillColor(C.muted)
    .text(WEBSITE, M, 44, { width: CW - 118, align: 'right', lineBreak: false })
    .text(SUPPORT_EMAIL, M, 57, { width: CW - 118, align: 'right', lineBreak: false });
  doc.lineWidth(0.8).strokeColor(C.ink).moveTo(M + CW - 104, 40).lineTo(M + CW - 104, 76).stroke();
  doc.font('regular').fontSize(7).fillColor(C.ink).text('WEAR\nBETTER\nEVERYDAY', M + CW - 92, 42, { characterSpacing: 2, lineGap: 1 });
  doc.lineWidth(0.8).strokeColor(C.line).moveTo(M, 92).lineTo(M + CW, 92).stroke();

  doc.font('bold').fontSize(21).fillColor(C.ink).text('TAX INVOICE', M, 102, { lineBreak: false });
  // Invoice number + date on one line, the order number on the next: all three
  // on one line wrapped mid-number.
  doc.font('regular').fontSize(9).fillColor(C.ink).text(`Invoice No: ${s.invoiceNumber}   |   Date: ${formatDate(s.issuedAt)}`, M, 129, { width: CW - 190, lineBreak: false });
  if (s.orderNumber) doc.font('regular').fontSize(8.5).fillColor(C.muted).text(`Order No: ${s.orderNumber}`, M, 142, { width: CW - 190, lineBreak: false });

  const badge = s.preview ? 'PREVIEW' : 'ORIGINAL FOR RECIPIENT';
  doc.roundedRect(M + CW - 138, 104, 138, 24, 5).fill(C.greenBg);
  doc.font('bold').fontSize(8.5).fillColor(C.green).text(badge, M + CW - 138, 111, { width: 138, align: 'center', lineBreak: false });
  doc.font('regular').fontSize(7).fillColor(C.muted).text(s.preview ? 'Not valid for GST input credit' : 'Tax payable on reverse charge: No', M + CW - 180, 133, { width: 180, align: 'right', lineBreak: false });
  return 160;
}

function drawFooter(doc) {
  const y = PAGE_H - 58;
  doc.lineWidth(0.8).strokeColor(C.line).moveTo(M, y).lineTo(M + CW, y).stroke();
  drawLogo(doc, M, y + 14, 110);
  doc.font('regular').fontSize(5.5).fillColor(C.ink).text('BUILD WITH PURPOSE', M + 9, y + 33, { characterSpacing: 2, lineBreak: false });
  doc.font('regular').fontSize(7).fillColor(C.ink).text('WEAR BETTER EVERYDAY', M, y + 22, { width: CW, align: 'right', characterSpacing: 2, lineBreak: false });
  doc.lineWidth(1).strokeColor(C.ink).moveTo(M + CW - 60, y + 36).lineTo(M + CW, y + 36).stroke();
}

function draw(doc, s, images) {
  const supplier = s.supplier || {};
  const bottomLimit = PAGE_H - 64;
  let y = drawHeader(doc, s);

  const colW = (CW - 12) / 2;
  const supplierState = supplier.stateName || supplier.address?.state;
  const supplierLines = [
    { text: `${supplier.legalName || ''}${supplier.tradeName ? ` (${supplier.tradeName})` : ''}`, bold: true, size: 9.5 },
    supplier.gstin ? { text: `GSTIN: ${supplier.gstin}` } : null,
    ...addressLines(supplier.address).map((t) => ({ text: t })),
    supplier.stateCode ? { text: `State: ${supplierState || '—'} (${supplier.stateCode})` } : null,
  ].filter(Boolean);
  const dispatch = s.dispatchFrom || {};
  const dispatchLines = dispatch.multiOrigin
    ? [{ text: `Multiple warehouses (${dispatch.count})`, bold: true, size: 9.5 }]
    : [{ text: dispatch.name || '—', bold: true, size: 9.5 }, ...addressLines(dispatch.address).map((t) => ({ text: t }))];
  doc.font('regular').fontSize(9);
  // Same arithmetic as panel(): 12 pad + 12 label + lines + 12 pad - 2.
  const probe = (lines) => 34 + lines.reduce((sum, l) => { doc.font(l.bold ? 'bold' : 'regular').fontSize(l.size || 8.5); return sum + doc.heightOfString(l.text, { width: colW - 24 }) + 1; }, 0);
  const topH = Math.max(probe(supplierLines), probe(dispatchLines));
  panel(doc, { x: M, y, w: colW, label: 'Supplier (Seller)', lines: supplierLines, minHeight: topH });
  panel(doc, { x: M + colW + 12, y, w: colW, label: 'Dispatch From', lines: dispatchLines, minHeight: topH });
  y += topH + 10;

  const buyer = s.billTo || s.shipTo || {};
  const pos = s.placeOfSupply;
  const buyerLines = [
    { text: personName(buyer) || '—', bold: true, size: 9.5 },
    ...addressLines(buyer).map((t) => ({ text: t })),
    buyer.phone ? { text: `Phone: ${buyer.phone}` } : null,
  ].filter(Boolean);
  const buyerH = panel(doc, {
    x: M, y, w: CW, label: 'Bill / Ship To', lines: buyerLines,
    right: pos ? {
      width: 170,
      draw: (rx, ry) => {
        labelText(doc, 'Place of supply', rx, ry, { width: 170, align: 'right' });
        doc.font('bold').fontSize(10).fillColor(C.ink).text(`${pos.state}${pos.code ? ` (${pos.code})` : ''}`, rx, ry + 13, { width: 170, align: 'right' });
      },
    } : null,
  });
  y += buyerH + 12;

  y = drawTableHeader(doc, y);
  (s.items || []).forEach((it, i) => {
    if (y + measureItemRow(doc, it).h > bottomLimit) {
      drawFooter(doc);
      doc.addPage({ size: 'A4', margin: 0 });
      y = drawTableHeader(doc, M);
    }
    y = drawItemRow(doc, y, i, it, images);
  });

  const summaryW = (CW - 12) / 2;
  const SIGNATURE_H = 36;
  if (y + 12 + summaryHeight(doc, s, summaryW) + 10 + SIGNATURE_H > bottomLimit) {
    drawFooter(doc);
    doc.addPage({ size: 'A4', margin: 0 });
    y = M;
  } else {
    y += 12;
  }
  const summaryH = drawSummary(doc, s, M, y, summaryW);
  drawThankYou(doc, M + summaryW + 12, y, summaryW, summaryH);
  y += summaryH + 10;

  const signer = supplier.tradeName || supplier.legalName || 'CORCOTTON';
  doc.font('regular').fontSize(7).fillColor(C.muted)
    .text((s.amounts?.pricesIncludeTax ? 'Prices are inclusive of GST. ' : '') + 'This is a computer-generated invoice.', M, y + 14, { width: CW / 2, lineBreak: false });
  doc.font('regular').fontSize(8).fillColor(C.ink).text(`For ${signer}`, M + CW / 2, y, { width: CW / 2, align: 'right', lineBreak: false });
  doc.lineWidth(0.8).strokeColor(C.ink).moveTo(M + CW - 130, y + 22).lineTo(M + CW, y + 22).stroke();
  doc.font('regular').fontSize(7).fillColor(C.muted).text('Authorised Signatory', M + CW / 2, y + 25, { width: CW / 2, align: 'right', lineBreak: false });

  drawFooter(doc);
}

/** @returns {Promise<Buffer>} */
export function buildInvoicePdf(snapshot, { images = new Map() } = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4', margin: 0, autoFirstPage: true, bufferPages: false,
        info: { Title: `Tax Invoice ${snapshot.invoiceNumber}`, Author: snapshot.supplier?.legalName || 'CORCOTTON', CreationDate: new Date(snapshot.issuedAt) },
      });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.registerFont('regular', FONT.regular);
      doc.registerFont('bold', FONT.bold);
      draw(doc, snapshot, images);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
