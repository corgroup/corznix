// A read-only approximation of the storefront search-result / share preview.
// Uses the product slug (the real URL handle — there is no separate SEO
// handle field) and the SEO title / meta description, falling back to the
// product name and short description the way the storefront does.
const STORE_ORIGIN = (import.meta.env.VITE_STOREFRONT_URL || 'https://corcotton.in').replace(/\/$/, '');

export function SeoPreview({ slug, title, description }) {
  const url = `${STORE_ORIGIN}/products/${slug || 'your-product'}`;
  return (
    <div className="seo-preview" aria-label="Search engine listing preview">
      <p className="seo-preview__url">{url}</p>
      <p className="seo-preview__title">{title || 'Untitled product'}</p>
      <p className="seo-preview__desc">
        {description || 'Add a meta description to control the snippet shown in search results.'}
      </p>
      <div className="seo-preview__counts">
        <span className={title && title.length > 60 ? 'is-over' : undefined}>{(title || '').length}/60 title</span>
        <span className={description && description.length > 160 ? 'is-over' : undefined}>{(description || '').length}/160 description</span>
      </div>
    </div>
  );
}

export default SeoPreview;
