import { ApiClient, ApiError } from '@cor-group/api-client';
import { getCurrentBrandId } from './brandContext.js';

// One shared HTTP client for the whole CMS. Every admin request flows
// React feature -> adminApi -> apiClient -> backend /api/v1/admin/*. No
// component makes a bare fetch. The shared client already sends
// `credentials: "include"`, so the HttpOnly staff session cookie rides
// along automatically — nothing here ever touches a token directly.
//
// Multi-company (DESIGN.md §6): every request also carries `x-brand-id`
// once `CompanyProvider` has resolved a current company — the backend's
// `resolveBrandContext` (Phase 2, advisory-only) reads it. Before login /
// before a company is resolved, `getCurrentBrandId()` is null and the
// header is simply omitted.
export const apiClient = new ApiClient({
  baseURL: import.meta.env.VITE_API_BASE_URL,
  getDefaultHeaders: () => {
    const brandId = getCurrentBrandId();
    return brandId ? { 'x-brand-id': brandId } : {};
  },
});

export { ApiError };
