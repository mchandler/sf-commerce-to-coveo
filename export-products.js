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
  fetchVariantAttributes,
  fetchCategoriesForCatalog,
  fetchProductCategoryLinks,
  fetchMedia,
} = require('./lib/lookups');
const { buildCategoryPaths } = require('./lib/categories');
const { buildDocument, buildImageUrl } = require('./lib/document');
const { createStreamWriter } = require('./lib/stream-writer');

function buildScope({ entitledParents, priceByProduct, variantParentById }) {
  const scope = new Set();
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
  let scope = buildScope({ entitledParents, priceByProduct, variantParentById });
  let scopeIds = Array.from(scope);
  if (cfg.limit != null && scopeIds.length > cfg.limit) {
    scopeIds = scopeIds.slice(0, cfg.limit);
    scope = new Set(scopeIds);
  }
  s5.done(`${scope.size} products in scope${cfg.limit != null ? ` (limited from ${priceByProduct.size})` : ''}`);

  if (scope.size === 0) {
    log('No products in scope. Exiting.');
    const writer = createStreamWriter(cfg.output);
    await writer.close();
    return;
  }

  const s6 = stageStart('products');
  const products = await fetchProducts(client, scopeIds, cfg.updatedAfter);
  s6.done(`${products.length} Product2 rows` +
    (cfg.updatedAfter ? ` (filtered by LastModifiedDate >= ${cfg.updatedAfter})` : ''));

  const s7 = stageStart('attributes');
  const variantIds = products
    .filter((p) => p.ProductClass === 'Variation')
    .map((p) => p.Id);
  const attrRows = await fetchVariantAttributes(client, variantIds);
  const attrByProduct = new Map();
  for (const r of attrRows) attrByProduct.set(r.ProductId, r);
  s7.done(`${attrRows.length} ProductAttribute rows for ${variantIds.length} variants`);

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
  let missingProductCodeCount = 0;
  const missingProductCodeSamples = [];
  let variantCount = 0;
  let simpleCount = 0;

  for (const p of products) {
    if (!p.ProductCode) {
      missingProductCodeCount++;
      if (missingProductCodeSamples.length < 5) missingProductCodeSamples.push(p.Id);
    }

    const isVariant = p.ProductClass === 'Variation';
    const variantParentId = isVariant ? (variantParentById.get(p.Id) || null) : null;
    if (isVariant) variantCount++; else simpleCount++;

    const doc = buildDocument({
      product: p,
      productAttr: attrByProduct.get(p.Id) || null,
      categoryPaths: Array.from(pathsByProduct.get(p.Id) || []),
      imageUrls: imagesByProduct.get(p.Id) || null,
      price: priceByProduct.get(p.Id) ?? null,
      variantParentId,
      siteUrl: cfg.siteUrl,
      brand: cfg.brand,
    });
    writer.write(doc);
  }

  const count = await writer.close();
  s10.done(
    `${count} documents written (${simpleCount} Simple, ${variantCount} Variation)`,
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
