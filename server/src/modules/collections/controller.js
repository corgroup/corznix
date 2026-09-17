import catalogService from '../catalog/service.js';

// The frontend's normalized Collection contract (see
// apps/corcotton/src/features/catalog/contracts) is a single flat list with
// a `parentCollection` field — the source project's own mock data already
// modeled it that way. The target database schema is cleaner and splits
// this into two real tables: `collections` (flat merchandising: new-in,
// bestsellers, sale) and `categories` (hierarchical: tops -> tshirts). This
// controller is where that reshaping happens (migration brief §44:
// "frontend/backend contract != database schema") — the frontend never
// needs to know the two are stored separately. `kind` still says which one a
// row is, so a surface that should list only categories (the homepage's
// Shop by Collection, All Collections) can.

// A category is on the storefront only when it and every category above it
// are active. listCategories returns the active ones, so a child whose parent
// was archived used to find no parent, fall back to parentCollection: null and
// appear as a top-level card — Headwear, Bags and Socks were listed on their
// own, with 0 items, after Accessories was archived and left the header.
function visibleCategories(categories) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const visible = (c, seen = new Set()) => {
    if (!c.parentId) return true;
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    const parent = byId.get(c.parentId);
    return Boolean(parent) && visible(parent, seen);
  };
  return categories.filter((c) => visible(c));
}

const categoryDto = (c, categories) => {
  const parent = c.parentId ? categories.find((p) => p.id === c.parentId) : null;
  return {
    id: c.slug,
    slug: c.slug,
    name: c.name,
    kind: 'CATEGORY',
    description: null,
    parentCollection: parent ? parent.slug : null,
    displayOrder: c.displayOrder,
    itemCount: c.productCount,
    image: c.thumbnailUrl || null,
  };
};

export async function listCollections(req, res, next) {
  try {
    const [merchandising, allCategories] = await Promise.all([
      catalogService.listCollections(),
      catalogService.listCategories(),
    ]);
    const categories = visibleCategories(allCategories);

    const merchandisingDtos = merchandising.map((c) => ({
      id: c.slug,
      slug: c.slug,
      name: c.name,
      kind: 'COLLECTION',
      description: c.description,
      parentCollection: null,
      displayOrder: c.displayOrder,
      itemCount: c.productCount,
      // Photo of a product in this collection; null when none has one.
      image: c.thumbnailUrl || null,
    }));

    const categoryDtos = categories.map((c) => categoryDto(c, categories));

    res.json({ data: [...merchandisingDtos, ...categoryDtos] });
  } catch (err) {
    next(err);
  }
}

export async function getCollectionBySlug(req, res, next) {
  try {
    const { slug } = req.params;
    const [merchandising, allCategories] = await Promise.all([
      catalogService.listCollections(),
      catalogService.listCategories(),
    ]);

    const collection = merchandising.find((c) => c.slug === slug);
    if (collection) {
      return res.json({
        data: {
          id: collection.slug, slug: collection.slug, name: collection.name, kind: 'COLLECTION',
          description: collection.description, parentCollection: null,
          itemCount: collection.productCount, image: collection.thumbnailUrl || null,
        },
      });
    }

    // Hidden with its archived parent here too, not only in the list.
    const categories = visibleCategories(allCategories);
    const category = categories.find((c) => c.slug === slug);
    if (category) {
      return res.json({ data: categoryDto(category, categories) });
    }

    return res.status(404).json({ error: { code: 'COLLECTION_NOT_FOUND', message: `No collection found with slug "${slug}".` } });
  } catch (err) {
    next(err);
  }
}
