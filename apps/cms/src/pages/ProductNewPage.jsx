// "New product" now opens the full creation workspace immediately — no
// mandatory "Create draft" step. The backend DRAFT is created lazily by
// ProductEditor's ensureDraft() via the existing POST /products endpoint.
import { ProductEditor } from '../features/catalog/ProductEditor.jsx';

export function ProductNewPage() {
  return <ProductEditor />;
}

export default ProductNewPage;
