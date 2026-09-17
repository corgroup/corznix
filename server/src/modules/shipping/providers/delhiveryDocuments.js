// Phase 2 · Slice 17 — Delhivery Download Document API
// (GET /api/rest/fetch/pkg/document/?doc_type={type}&waybill={awb}).
//
// Dev_API.docx #15 names the doc_type values (SIGNATURE_URL, RVP_QC_IMAGE,
// EPOD, SELLER_RETURN_IMAGE) but does NOT field-spec the response body. The
// `_URL` suffix on SIGNATURE_URL indicates the endpoint returns a link; the
// parser looks for a URL across the plausible keys and returns
// `{ ok: false }` for anything else — it never fabricates one.

// CORCOTTON doc type -> Delhivery doc_type. SORTER_IMAGE has no pull endpoint
// (webhook only); reverse SELLER_RETURN_IMAGE is out of the forward program.
export const DELHIVERY_DOC_TYPE = Object.freeze({
  EPOD: 'EPOD',
  QC_IMAGE: 'RVP_QC_IMAGE',
  SIGNATURE: 'SIGNATURE_URL',
});

function firstUrl(node, seen = new Set()) {
  if (node == null || seen.has(node)) return null;
  if (typeof node === 'string') {
    const s = node.trim();
    return /^https?:\/\/\S+$/i.test(s) ? s : null;
  }
  if (typeof node !== 'object') return null;
  seen.add(node);
  // Prefer obviously-named keys first.
  for (const k of ['url', 'URL', 'document_url', 'doc_url', 'signature_url', 's3_link', 'link', 'download_url', 'pdf_download_link']) {
    const found = firstUrl(node[k], seen);
    if (found) return found;
  }
  for (const v of Array.isArray(node) ? node : Object.values(node)) {
    const found = firstUrl(v, seen);
    if (found) return found;
  }
  return null;
}

/**
 * @param {any} data raw JSON body from the Download Document endpoint
 * @returns {{ ok: true, url: string } | { ok: false }}
 */
export function parseDocumentResponse(data) {
  const url = firstUrl(data);
  return url ? { ok: true, url } : { ok: false };
}
