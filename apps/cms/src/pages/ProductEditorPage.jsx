// Route entry for editing an existing product. Shares the ProductEditor
// workspace with the create flow (`ProductNewPage`).
import { useParams } from 'react-router-dom';
import { ProductEditor } from '../features/catalog/ProductEditor.jsx';

export function ProductEditorPage() {
  const { id } = useParams();
  return <ProductEditor key={id} productId={id} />;
}

export default ProductEditorPage;
