import * as brandsService from './service.js';

export async function getBrands(req, res, next) {
  try {
    const brands = await brandsService.listBrands();
    res.json({ data: brands });
  } catch (err) {
    next(err);
  }
}

export async function getBrandBySlug(req, res, next) {
  try {
    const brand = await brandsService.getBrandBySlug(req.params.slug);
    res.json({ data: brand });
  } catch (err) {
    next(err);
  }
}
