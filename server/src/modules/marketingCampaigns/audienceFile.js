// Parsing and validating an uploaded campaign audience file.
//
// Two formats, no new dependency:
//
//   CSV / TSV  parsed here, including RFC-4180 quoting ("a,b" and "" escapes),
//              because a contact list routinely contains a name with a comma.
//   XLSX       is a ZIP of XML. Node already ships zlib, so the ZIP central
//              directory is walked and the two parts that matter
//              (xl/sharedStrings.xml, the first worksheet) are inflated and
//              read. A spreadsheet library would be a much larger supply-chain
//              surface for a feature that reads three columns.
//
// Anything the reader cannot handle (an encrypted or ZIP64 workbook) fails
// with a message that tells the admin to save as CSV, rather than importing a
// partial list and calling it a success.
import { inflateRawSync } from 'node:zlib';
import { normalizeIndianMobile } from '../notifications/recipients.js';

// Generous enough for a real list, small enough that a mistaken upload of a
// product export cannot become a 200k-row campaign.
export const MAX_AUDIENCE_ROWS = 50_000;

// ---------------------------------------------------------------------------
// CSV / TSV
// ---------------------------------------------------------------------------

/** RFC-4180-ish reader: quoted fields, "" escapes, CRLF or LF, chosen delimiter. */
function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---------------------------------------------------------------------------
// XLSX (ZIP + XML)
// ---------------------------------------------------------------------------

/** Walk the ZIP end-of-central-directory and return {name -> Buffer}. */
function readZipEntries(buffer) {
  // End of central directory record: signature 0x06054b50, within the last 64k.
  const sigEOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66000); i -= 1) {
    if (buffer.readUInt32LE(i) === sigEOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('XLSX_UNREADABLE');
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff) throw new Error('XLSX_ZIP64_UNSUPPORTED');

  const entries = new Map();
  for (let n = 0; n < entryCount; n += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('XLSX_UNREADABLE');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;

    // Only inflate the two parts we actually read.
    if (!/^xl\/(sharedStrings\.xml|worksheets\/)/.test(name)) continue;
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('XLSX_UNREADABLE');
    const lNameLen = buffer.readUInt16LE(localOffset + 26);
    const lExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) entries.set(name, Buffer.from(raw));
    else if (method === 8) entries.set(name, inflateRawSync(raw));
    else throw new Error('XLSX_COMPRESSION_UNSUPPORTED');
  }
  return entries;
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = (s) => String(s).replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return XML_ENTITIES[e] ?? m;
});

/** Shared strings table: <si> entries, each possibly split across <t> runs. */
function readSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => {
    const runs = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1]));
    return runs.join('');
  });
}

const columnIndex = (ref) => {
  const letters = String(ref).match(/^[A-Z]+/)?.[0] || 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

function readSheet(xml, shared) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cell of rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cell[1];
      const ref = attrs.match(/r="([A-Z]+\d+)"/)?.[1] || 'A1';
      const type = attrs.match(/t="([^"]+)"/)?.[1] || 'n';
      const inline = cell[2].match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/)?.[1];
      const raw = cell[2].match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let value = '';
      if (type === 's') value = shared[Number(raw)] ?? '';
      else if (type === 'inlineStr') value = decodeXml(inline ?? '');
      else value = decodeXml(raw ?? '');
      cells[columnIndex(ref)] = value;
    }
    // Self-closing <row .../> (an entirely empty row) yields nothing; keep the
    // position so source_row still matches what the admin sees in Excel.
    rows.push([...cells].map((c) => c ?? ''));
  }
  return rows;
}

function parseXlsx(buffer) {
  const entries = readZipEntries(buffer);
  const sheetName = [...entries.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort()[0];
  if (!sheetName) throw new Error('XLSX_NO_SHEET');
  const shared = readSharedStrings(entries.get('xl/sharedStrings.xml')?.toString('utf8'));
  return readSheet(entries.get(sheetName).toString('utf8'), shared);
}

// ---------------------------------------------------------------------------
// Column mapping + validation
// ---------------------------------------------------------------------------

const HEADER_ALIASES = {
  name: ['name', 'full name', 'fullname', 'customer', 'customer name', 'contact name', 'first name'],
  phone: ['phone', 'mobile', 'phone number', 'mobile number', 'whatsapp', 'whatsapp number', 'contact', 'msisdn'],
  email: ['email', 'e-mail', 'email address', 'mail', 'email id'],
};

function mapHeader(headerRow) {
  const normalized = headerRow.map((h) => String(h || '').trim().toLowerCase());
  const map = { name: -1, phone: -1, email: -1 };
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    map[field] = normalized.findIndex((h) => aliases.includes(h));
  }
  return map;
}

// Deliberately permissive but not meaningless: one @, a dot in the domain, no
// spaces. Marketing lists are full of "n/a" and "none" — those must be
// reported as invalid, not sent to.
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i;

/**
 * @returns {{rows: Array, counts: {total:number, valid:number, invalid:number, duplicate:number}}}
 */
export function parseAudienceFile(buffer, filename) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  let grid;
  if (ext === 'xlsx') {
    grid = parseXlsx(buffer);
  } else if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
    // Strip a UTF-8 BOM: Excel writes one, and it would otherwise make the
    // first header cell U+FEFF + "Name" and silently unmatch that column.
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
    const delimiter = ext === 'tsv' ? '\t'
      : (text.split('\n')[0].split('\t').length > text.split('\n')[0].split(',').length ? '\t' : ',');
    grid = parseDelimited(text, delimiter);
  } else {
    const err = new Error('UNSUPPORTED_FILE_TYPE');
    err.userMessage = 'Upload a .csv or .xlsx file.';
    throw err;
  }

  grid = grid.filter((row) => row.some((cell) => String(cell || '').trim() !== ''));
  if (!grid.length) {
    const err = new Error('EMPTY_FILE');
    err.userMessage = 'That file has no rows.';
    throw err;
  }

  const map = mapHeader(grid[0]);
  const hasHeader = map.phone >= 0 || map.email >= 0;
  if (!hasHeader) {
    const err = new Error('NO_CONTACT_COLUMN');
    err.userMessage = 'No Phone or Email column found. Name the columns Name, Phone and Email.';
    throw err;
  }
  const body = grid.slice(1);
  if (body.length > MAX_AUDIENCE_ROWS) {
    const err = new Error('TOO_MANY_ROWS');
    err.userMessage = `That file has ${body.length} rows; the limit is ${MAX_AUDIENCE_ROWS}.`;
    throw err;
  }

  const seen = new Set();
  const rows = body.map((cells, i) => {
    const pick = (idx) => (idx >= 0 ? String(cells[idx] ?? '').trim() : '');
    const rawName = pick(map.name);
    const rawPhone = pick(map.phone);
    const rawEmail = pick(map.email);

    const phone = rawPhone ? normalizeIndianMobile(rawPhone) : null;
    const emailLower = rawEmail.toLowerCase();
    const email = rawEmail && EMAIL_RE.test(emailLower) ? emailLower : null;

    const out = {
      // +2: one for the header line, one because spreadsheets are 1-based.
      sourceRow: i + 2,
      rawName: rawName || null,
      rawPhone: rawPhone || null,
      rawEmail: rawEmail || null,
      phoneE164: phone,
      email,
      importStatus: 'VALID',
      invalidReason: null,
    };

    if (!phone && !email) {
      out.importStatus = 'INVALID';
      // Say WHICH value was rejected, so the admin can fix the file.
      out.invalidReason = rawPhone && rawEmail ? 'Phone and email are both invalid'
        : rawPhone ? 'Phone is not a valid Indian mobile number'
          : rawEmail ? 'Email address is not valid'
            : 'Row has neither a phone number nor an email address';
      return out;
    }

    // A contact is the same contact if either identifier repeats. Checking both
    // keys stops the same person being messaged twice because one row carried
    // their phone and another their email.
    const keys = [phone && `p:${phone}`, email && `e:${email}`].filter(Boolean);
    if (keys.some((k) => seen.has(k))) {
      out.importStatus = 'DUPLICATE';
      out.invalidReason = 'Already in this file';
      return out;
    }
    keys.forEach((k) => seen.add(k));
    return out;
  });

  // Broken down the way the admin asked for it: "invalid" alone does not say
  // whether the file is missing a column or full of malformed numbers.
  const counts = {
    total: rows.length,
    valid: rows.filter((r) => r.importStatus === 'VALID').length,
    invalid: rows.filter((r) => r.importStatus === 'INVALID').length,
    duplicate: rows.filter((r) => r.importStatus === 'DUPLICATE').length,
    missingPhone: rows.filter((r) => !r.rawPhone).length,
    missingEmail: rows.filter((r) => !r.rawEmail).length,
    invalidPhone: rows.filter((r) => r.rawPhone && !r.phoneE164).length,
    invalidEmail: rows.filter((r) => r.rawEmail && !r.email).length,
  };
  return { rows, counts };
}
