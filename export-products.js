#!/usr/bin/env node
'use strict';

const { resolveConfig } = require('./lib/args');
const { createSession } = require('./lib/auth');
const { createClient } = require('./lib/http');
const { stageStart, log, formatDuration } = require('./lib/progress');
const {
  fetchCatalogIdForWebStore,
  fetchEntitledProductIds,
  fetchPriceByProductId,
  fetchVariantParentMap,
  fetchProducts,
  // fetchVariantAttributes,  // unused while attribute source = Product2
  fetchCategoriesForCatalog,
  fetchProductCategoryLinks,
  fetchMedia,
} = require('./lib/lookups');
const { buildCategoryPaths } = require('./lib/categories');
const { buildDocument, buildImageUrl } = require('./lib/document');
const { createStreamWriter } = require('./lib/stream-writer');
const { createUnpricedLog } = require('./lib/unpriced-log');

function buildScope({ entitledParents, priceByProduct, variantParentById, includeUnpriced }) {
  const scope = new Set();
  if (includeUnpriced) {
    // Entitled-driven: every entitled Product2 plus the variant children of
    // entitled parents. VariationParents themselves get filtered out later
    // by the ProductClass clause in fetchProducts.
    for (const id of entitledParents) scope.add(id);
    for (const [childId, parentId] of variantParentById.entries()) {
      if (entitledParents.has(parentId)) scope.add(childId);
    }
    return scope;
  }
  // Priced-driven (default): every priced product that is entitled directly
  // or whose variant parent is entitled.
  for (const productId of priceByProduct.keys()) {
    if (entitledParents.has(productId)) {
      scope.add(productId);
      continue;
    }
    const parentId = variantParentById.get(productId);
    if (parentId && entitledParents.has(parentId)) {
      scope.add(productId);
    }
  }
  return scope;
}

// Fisher–Yates in place. Used only when --limit is applied, so a small
// limit still samples across entitled parents AND their variant children
// rather than taking the first N insertion entries (which are all parents).
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const IMAGE_CONTENT_TYPES = new Set(['cms_image', 'sfdc_cms__image']);

function buildImageUrlsByProduct(mediaRows, siteUrl) {
  const grouped = new Map();
  for (const r of mediaRows) {
    if (!r.ContentKey) continue;
    if (r.ContentType && !IMAGE_CONTENT_TYPES.has(r.ContentType)) continue;
    let arr = grouped.get(r.ProductId);
    if (!arr) {
      arr = [];
      grouped.set(r.ProductId, arr);
    }
    arr.push({ sortOrder: r.SortOrder ?? 0, contentKey: r.ContentKey });
  }

  const out = new Map();
  for (const [productId, entries] of grouped.entries()) {
    entries.sort((a, b) => a.sortOrder - b.sortOrder);
    const urls = entries
      .map((e) => buildImageUrl(siteUrl, e.contentKey))
      .filter((u) => u != null);
    if (urls.length > 0) out.set(productId, urls);
  }
  return out;
}

async function main() {
  const started = Date.now();
  const cfg = resolveConfig(process.argv.slice(2));

  log(`Org:         ${cfg.sfOrg}`);
  log(`Site URL:    ${cfg.siteUrl}`);
  log(`WebStore:    ${cfg.webstoreId}`);
  log(`Policy:      ${cfg.policyId}`);
  log(`Pricebook:   ${cfg.pricebookId}`);
  log(`Output:      ${cfg.output}`);
  if (cfg.updatedAfter) log(`Updated after: ${cfg.updatedAfter}`);
  if (cfg.limit != null) log(`Limit:       ${cfg.limit}`);
  if (cfg.includeUnpriced) log(`Include unpriced: on (ec_price=0 when no PricebookEntry; sidecar CSV emitted)`);
  log('');

  const session = createSession(cfg.sfOrg);
  const sess = await session.get();
  log(`Authenticated as ${sess.username || '(unknown)'} @ ${sess.instanceUrl}`);
  log('');

  const client = createClient(session);

  const s1 = stageStart('catalog');
  const catalogId = await fetchCatalogIdForWebStore(client, cfg.webstoreId);
  s1.done(`ProductCatalogId = ${catalogId}`);

  const s2 = stageStart('entitlement');
  const entitledParents = await fetchEntitledProductIds(client, cfg.policyId);
  s2.done(`${entitledParents.size} entitled Product2 Ids`);

  const s3 = stageStart('pricing');
  const priceByProduct = await fetchPriceByProductId(client, cfg.pricebookId);
  s3.done(`${priceByProduct.size} PricebookEntry rows`);

  const s4 = stageStart('variants');
  const variantParentById = await fetchVariantParentMap(client);
  s4.done(`${variantParentById.size} variant→parent pairs`);

  const s5 = stageStart('scope');
  let scope = buildScope({
    entitledParents,
    priceByProduct,
    variantParentById,
    includeUnpriced: cfg.includeUnpriced,
  });
  const preLimitSize = scope.size;
  let scopeIds = Array.from(scope);
  if (cfg.limit != null && scopeIds.length > cfg.limit) {
    shuffle(scopeIds);
    scopeIds = scopeIds.slice(0, cfg.limit);
    scope = new Set(scopeIds);
  }
  const sampledNote = preLimitSize > scope.size ? ` (sampled from ${preLimitSize})` : '';
  s5.done(`${scope.size} products in scope${sampledNote}`);

  if (scope.size === 0) {
    log('No products in scope. Exiting.');
    const writer = createStreamWriter(cfg.output);
    await writer.close();
    return;
  }

  const s6 = stageStart('products');
  const products = await fetchProducts(client, scopeIds, cfg.updatedAfter);
  const dropped = scope.size - products.length;
  // The drop can come from three filters in fetchProducts' SOQL:
  //   - IsActive = false
  //   - ProductClass = 'VariationParent' (excluded by spec rule #3)
  //   - LastModifiedDate < :updatedAfter (when --updated-after is set)
  const dropNote = dropped > 0 ? ` (${dropped} dropped from scope as inactive, VariationParent, or unchanged)` : '';
  s6.done(`${products.length} Product2 rows${dropNote}`);

  // Attribute source currently = Product2 (values pulled in fetchProducts
  // above). The ProductAttribute fetch below is commented out while the
  // data team is only confident in Product2-sourced attribute data. To
  // revert: uncomment this block, uncomment the ProductAttribute iteration
  // in lib/document.js, add `productAttr` back to the buildDocument call
  // below, and remove ATTRIBUTE_FIELDS_FROM_PRODUCT2 from the SELECT in
  // lib/lookups.js fetchProducts.
  // const s7 = stageStart('attributes');
  // const variantIds = products
  //   .filter((p) => p.ProductClass === 'Variation')
  //   .map((p) => p.Id);
  // const attrRows = await fetchVariantAttributes(client, variantIds);
  // const attrByProduct = new Map();
  // for (const r of attrRows) attrByProduct.set(r.ProductId, r);
  // s7.done(`${attrRows.length} ProductAttribute rows for ${variantIds.length} variants`);

  const s8 = stageStart('categories');
  const [categoryRows, productCategoryRows] = await Promise.all([
    fetchCategoriesForCatalog(client, catalogId),
    fetchProductCategoryLinks(client, catalogId),
  ]);
  const pathsByProduct = buildCategoryPaths(
    categoryRows,
    productCategoryRows,
    variantParentById,
  );
  s8.done(
    `${categoryRows.length} categories, ${productCategoryRows.length} assignments, ` +
    `${pathsByProduct.size} products with paths`,
  );

  const s9 = stageStart('media');
  const mediaRows = await fetchMedia(client, scopeIds);
  const imagesByProduct = buildImageUrlsByProduct(mediaRows, cfg.siteUrl);
  s9.done(`${mediaRows.length} ProductMedia rows, ${imagesByProduct.size} products with images`);

  const s10 = stageStart('assemble');
  const writer = createStreamWriter(cfg.output);
  const unpricedLog = cfg.includeUnpriced ? createUnpricedLog(cfg.output) : null;
  let missingProductCodeCount = 0;
  const missingProductCodeSamples = [];
  let variantCount = 0;
  let simpleCount = 0;
  let unpricedCount = 0;

  for (const p of products) {
    if (!p.ProductCode) {
      missingProductCodeCount++;
      if (missingProductCodeSamples.length < 5) missingProductCodeSamples.push(p.Id);
    }

    const isVariant = p.ProductClass === 'Variation';
    const variantParentId = isVariant ? (variantParentById.get(p.Id) || null) : null;
    if (isVariant) variantCount++; else simpleCount++;

    const price = priceByProduct.get(p.Id) ?? null;
    if (cfg.includeUnpriced && price == null) {
      unpricedCount++;
      unpricedLog.log({
        ProductId: p.Id,
        ProductCode: p.ProductCode,
        StockKeepingUnit: p.StockKeepingUnit,
        Name: p.Name,
        ProductClass: p.ProductClass,
        ParentId: variantParentId || '',
      });
    }

    const doc = buildDocument({
      product: p,
      // productAttr: attrByProduct.get(p.Id) || null,  // revert path: uncomment with the attributes stage above
      categoryPaths: Array.from(pathsByProduct.get(p.Id) || []),
      imageUrls: imagesByProduct.get(p.Id) || null,
      price,
      variantParentId,
      siteUrl: cfg.siteUrl,
      brand: cfg.brand,
      includeUnpriced: cfg.includeUnpriced,
    });
    writer.write(doc);
  }

  const count = await writer.close();
  if (unpricedLog) await unpricedLog.close();
  const unpricedSuffix = cfg.includeUnpriced ? `; ${unpricedCount} without PricebookEntry` : '';
  s10.done(
    `${count} documents written (${simpleCount} Simple, ${variantCount} Variation${unpricedSuffix})`,
  );

  if (missingProductCodeCount > 0) {
    log('');
    log(
      `WARNING: ${missingProductCodeCount} product(s) missing ProductCode — fell back to Id for ec_product_id.`,
    );
    log(`  Sample Ids: ${missingProductCodeSamples.join(', ')}`);
  }

  log('');
  log(`Wrote ${count} documents to ${cfg.output}`);
  if (unpricedLog && unpricedLog.count > 0) {
    log(`Wrote ${unpricedLog.count} unpriced rows to ${unpricedLog.file}`);
  }
  log(`Total elapsed: ${formatDuration(Date.now() - started)}`);
}

main().catch((err) => {
  console.error('');
  console.error('Fatal error:', err.message);
  if (err.status && err.body) {
    console.error(`  HTTP ${err.status} body: ${String(err.body).slice(0, 500)}`);
  }
  process.exit(2);
});
