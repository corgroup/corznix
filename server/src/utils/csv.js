// Minimal, dependency-free CSV serialisation for the CMS admin exports.
// RFC 4180: fields containing a comma, quote or newline are wrapped in double
// quotes with internal quotes doubled. A leading BOM keeps Excel honest about
// UTF-8.

function cell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * @param {string[]} headers
 * @param {Array<Array<string|number|null>>} rows
 * @returns {string}
 */
export function toCsv(headers, rows) {
  const lines = [headers.map(cell).join(',')];
  for (const row of rows) lines.push(row.map(cell).join(','));
  // A UTF-8 BOM, on purpose: without it Excel opens the file as the local
  // codepage and mangles every non-ASCII name. Written as an escape so it is
  // visible to a reader instead of being an invisible character in the source.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** Send a CSV body as a download with a timestamped filename. */
export function sendCsv(res, filename, csv) {
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}-${stamp}.csv"`);
  res.status(200).send(csv);
}
