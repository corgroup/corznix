// Multi-company CMS (implementation/multi-company/DESIGN.md §6) — the
// current company id, mirrored outside React so `apiClient` (a module-level
// singleton created before any component renders) can read it on every
// request without a circular import into the CompanyProvider. `CompanyProvider`
// is the only writer; everything else only reads via `apiClient`'s
// `getDefaultHeaders`.
let currentBrandId = null;

export function setCurrentBrandId(brandId) {
  currentBrandId = brandId || null;
}

export function getCurrentBrandId() {
  return currentBrandId;
}
