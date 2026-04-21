'use strict';

// Build a Map<productId, Set<pathString>>, where each path is pipe-joined:
// e.g. "Patio Door Parts|Door Styles|Inswing Patio Doors".
//
// Inputs:
//   categoryRows           - ProductCategory rows: { Id, Name, ParentCategoryId }
//   productCategoryRows    - ProductCategoryProduct rows: { ProductId, ProductCategoryId }
//   variantParentById      - Map<childProductId, parentProductId> for inheritance
function buildCategoryPaths(categoryRows, productCategoryRows, variantParentById) {
  const byId = new Map();
  for (const r of categoryRows) byId.set(r.Id, r);

  const pathCache = new Map();
  function pathFor(categoryId) {
    if (pathCache.has(categoryId)) return pathCache.get(categoryId);
    const node = byId.get(categoryId);
    if (!node) {
      pathCache.set(categoryId, null);
      return null;
    }
    const parentPath = node.ParentCategoryId ? pathFor(node.ParentCategoryId) : null;
    const path = parentPath ? `${parentPath}|${node.Name}` : node.Name;
    pathCache.set(categoryId, path);
    return path;
  }

  const pathsByProduct = new Map();
  for (const r of productCategoryRows) {
    const p = pathFor(r.ProductCategoryId);
    if (!p) continue;
    let set = pathsByProduct.get(r.ProductId);
    if (!set) {
      set = new Set();
      pathsByProduct.set(r.ProductId, set);
    }
    set.add(p);
  }

  // Variant children inherit their parent's categories.
  for (const [childId, parentId] of variantParentById.entries()) {
    const parentPaths = pathsByProduct.get(parentId);
    if (!parentPaths) continue;
    let childSet = pathsByProduct.get(childId);
    if (!childSet) {
      childSet = new Set();
      pathsByProduct.set(childId, childSet);
    }
    for (const p of parentPaths) childSet.add(p);
  }

  return pathsByProduct;
}

module.exports = { buildCategoryPaths };
