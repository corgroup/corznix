// Zero-dependency PDF writer for text-only operational documents (invoices,
// packing slips, mock labels). Produces a valid %PDF-1.4 file with the
// standard-14 Helvetica font (no embedding) — enough for deterministic,
// auditable artefacts without pulling a PDF library.
//
//   buildPdf({ pageSize: 'A4' | 'LABEL_4X6', lines: [{ text, size?, gap?, bold? }] })
//     -> Buffer

const PAGE = {
  A4: { w: 595, h: 842, margin: 48, defaultSize: 10 },
  LABEL_4X6: { w: 288, h: 432, margin: 16, defaultSize: 9 },
};

// The standard-14 fonts only carry Latin-1 and the file is written as latin1,
// so characters outside it were lost: a product named "… T-Shirt — White"
// printed as "T-Shirt  White" on the invoice. Common typographic characters
// are mapped to Latin-1 equivalents; anything else becomes "?" rather than
// vanishing silently.
const LATIN1_EQUIVALENT = { '\u2014': '-', '\u2013': '-', '\u2212': '-', '\u2018': "'", '\u2019': "'", '\u201C': '"', '\u201D': '"', '\u2026': '...', '\u20B9': 'Rs.', '\u2022': '*' };
const toLatin1 = (s) => String(s ?? '')
  .replace(/[\u2014\u2013\u2212\u2018\u2019\u201C\u201D\u2026\u20B9\u2022]/g, (c) => LATIN1_EQUIVALENT[c])
  .replace(/[Ā-￿]/g, '?');
const escapeText = (s) => toLatin1(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/[\r\n]+/g, ' ');

// Nothing wrapped before, so a long invoice item line ran off the right edge of
// the page and its tax and line total were cut off. Lines now wrap on word
// boundaries to the printable width. Helvetica averages ~0.5em per character;
// 0.55em is a conservative width so wrapped text stays inside the margin.
function wrapText(text, maxChars) {
  const words = String(text ?? '').split(/(\s+)/);
  const out = [];
  let current = '';
  for (const part of words) {
    if ((current + part).length <= maxChars) { current += part; continue; }
    if (current.trim()) out.push(current.trimEnd());
    let rest = part.trimStart();
    while (rest.length > maxChars) { out.push(rest.slice(0, maxChars)); rest = rest.slice(maxChars); }
    current = rest;
  }
  if (current.trim() || out.length === 0) out.push(current.trimEnd());
  return out;
}

export function buildPdf({ pageSize = 'A4', lines = [] } = {}) {
  const page = PAGE[pageSize] || PAGE.A4;
  const pages = [];
  let cursor = { y: page.h - page.margin, content: [] };
  const flush = () => { pages.push(cursor.content.join('\n')); };

  for (const raw of lines) {
    const line = typeof raw === 'string' ? { text: raw } : raw;
    const size = line.size || page.defaultSize;
    const font = line.bold ? '/F2' : '/F1';
    const maxChars = Math.max(10, Math.floor((page.w - page.margin * 2) / (size * 0.55)));
    const segments = wrapText(toLatin1(line.text), maxChars);
    segments.forEach((segment, i) => {
      // Wrapped continuation lines sit at the normal line height; the line's own
      // gap applies after its last segment.
      const gap = i === segments.length - 1 ? (line.gap ?? size + 4) : size + 4;
      if (cursor.y - gap < page.margin) { flush(); cursor = { y: page.h - page.margin, content: [] }; }
      cursor.content.push(`BT ${font} ${size} Tf ${page.margin} ${Math.round(cursor.y)} Td (${escapeText(segment)}) Tj ET`);
      cursor.y -= gap;
    });
  }
  flush();
  if (pages.length === 0) pages.push('');

  // Object layout: 1 Catalog, 2 Pages, [3..] alternating Page + Content, then 2 fonts.
  const objects = [];
  const pageObjIds = [];
  let nextId = 3;
  for (let i = 0; i < pages.length; i += 1) { pageObjIds.push(nextId); nextId += 2; }
  const fontRegularId = nextId;
  const fontBoldId = nextId + 1;

  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  pages.forEach((content, i) => {
    const pageId = pageObjIds[i];
    const contentId = pageId + 1;
    const stream = `q\n${content}\nQ`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.w} ${page.h}] /Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });
  objects[fontRegularId] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
  objects[fontBoldId] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let id = 1; id < objects.length; id += 1) {
    if (!objects[id]) continue;
    offsets[id] = Buffer.byteLength(pdf);
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(pdf);
  const count = objects.length;
  pdf += `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id += 1) {
    pdf += offsets[id] != null ? `${String(offsets[id]).padStart(10, '0')} 00000 n \n` : `0000000000 00000 f \n`;
  }
  pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}
