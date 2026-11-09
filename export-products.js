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
  fetchPromoPriceByProductId,
  fetchVariantParentMap,
  fetchProductIdsByCode,
  fetchProductsForDelete,
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
// Resolves --product-code-deletes into Coveo delete entries. Logs codes with
// no Product2 match, codes shared by several Product2 rows, VariationParents
// (never indexed, so skipped), and codes that still pass the export filters
// (the next update run would re-add them).
async function buildDeletes(client, cfg, fullScope) {
  const rows = await fetchProductsForDelete(client, cfg.productCodeDeletes);

  const rowsByCode = new Map();
  for (const r of rows) {
    const key = String(r.ProductCode).toLowerCase();
    let arr = rowsByCode.get(key);
    if (!arr) rowsByCode.set(key, (arr = []));
    arr.push(r);
  }

  const notFound = [];
  const duplicates = [];
  const variationParents = [];
  const stillExported = [];
  const deletes = [];
  const deleteIds = new Set();

  for (const code of cfg.productCodeDeletes) {
    const matches = rowsByCode.get(code.toLowerCase());
    if (!matches) {
      notFound.push(code);
      continue;
    }
    if (matches.length > 1) duplicates.push(`${code} (${matches.map((r) => r.Id).join(', ')})`);
    for (const r of matches) {
      if (deleteIds.has(r.Id)) continue;
      if (r.ProductClass === 'VariationParent') {
        variationParents.push(`${code} (${r.Id})`);
        continue;
      }
      // Same filters fetchProducts applies, minus --updated-after: would a
      // future export run emit this product again?
      if (
        fullScope.has(r.Id) &&
        r.IsActive === true &&
        r.Active_on_Parts_Store__c === true
      ) {
        stillExported.push(`${code} (${r.Id})`);
      }
      deleteIds.add(r.Id);
      // Must match lib/document.js buildDocument exactly.
      deletes.push({ documentId: `${cfg.siteUrl}/product/${r.Id}`, deleteChildren: false });
    }
  }

  return { deletes, deleteIds, notFound, duplicates, variationParents, stillExported };
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const IMAGE_CONTENT_TYPES = new Set(['cms_image', 'sfdc_cms__image']);

function buildImageUrlsByProduct(mediaRows, siteUrl, customDomain) {
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
      .map((e) => buildImageUrl(siteUrl, e.contentKey, customDomain))
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
  log(`Pricebook:         ${cfg.pricebookId}`);
  log(`Promo Pricebook:   ${cfg.promoPricebookId ?? '(none)'}`);
  log(`Output:      ${cfg.output}`);
  if (cfg.updatedAfter) log(`Updated after: ${cfg.updatedAfter}`);
  if (cfg.productCodes) log(`Product codes: ${cfg.productCodes.length} requested`);
  if (cfg.productCodeDeletes) {
    log(`Product code deletes: ${cfg.productCodeDeletes.length} requested${cfg.deletesOnly ? ' (delete-only payload)' : ''}`);
  }
  if (cfg.deletesOnly && cfg.limit != null) log(`Limit:       ignored (delete-only payload)`);
  if (cfg.limit != null) log(`Limit:       ${cfg.limit}`);
  if (cfg.includeUnpriced) log(`Include unpriced: on (ec_price=0 when no PricebookEntry; sidecar CSV emitted)`);
  log(`Image transform: ${cfg.customDomain ? 'none (custom domain — /cdn-cgi/image/ omitted)' : 'cdn-cgi (format=auto)'}`);
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

  let promoPriceByProduct = null;
  if (cfg.promoPricebookId) {
    const sP = stageStart('promo pricing');
    promoPriceByProduct = await fetchPromoPriceByProductId(client, cfg.promoPricebookId);
    sP.done(`${promoPriceByProduct.size} promo PricebookEntry rows`);
  }

  const s4 = stageStart('variants');
  const variantParentById = await fetchVariantParentMap(client);
  s4.done(`${variantParentById.size} variant→parent pairs`);

  const s5 = stageStart('scope');
  let codeNotFound = [];
  let codeOutOfScope = [];
  let scope = buildScope({
    entitledParents,
    priceByProduct,
    variantParentById,
    includeUnpriced: cfg.includeUnpriced,
  });
  // Unfiltered scope, kept for the --product-code-deletes "would be re-added"
  // check, which asks about future broad runs, not this run's code filter.
  const fullScope = scope;
  let codeNote = '';
  if (cfg.productCodes) {
    // SOQL IN on a text field is case-insensitive, so match codes the same
    // way when reporting which ones were not found or fell outside scope.
    const codeRows = await fetchProductIdsByCode(client, cfg.productCodes);
    const foundCodes = new Set(codeRows.map((r) => String(r.ProductCode).toLowerCase()));
    const inScopeCodes = new Set();
    const filtered = new Set();
    for (const r of codeRows) {
      if (!scope.has(r.Id)) continue;
      filtered.add(r.Id);
      inScopeCodes.add(String(r.ProductCode).toLowerCase());
    }
    scope = filtered;
    codeNotFound = cfg.productCodes.filter((c) => !foundCodes.has(c.toLowerCase()));
    codeOutOfScope = cfg.productCodes.filter(
      (c) => foundCodes.has(c.toLowerCase()) && !inScopeCodes.has(c.toLowerCase()),
    );
    codeNote = ` (filtered to ${cfg.productCodes.length} product code(s))`;
  }
  const preLimitSize = scope.size;
  let scopeIds = Array.from(scope);
  if (cfg.limit != null && scopeIds.length > cfg.limit) {
    shuffle(scopeIds);
    scopeIds = scopeIds.slice(0, cfg.limit);
    scope = new Set(scopeIds);
  }
  const sampledNote = preLimitSize > scope.size ? ` (sampled from ${preLimitSize})` : '';
  s5.done(`${scope.size} products in scope${codeNote}${sampledNote}`);
  if (codeNotFound.length > 0) {
    log(`  ${codeNotFound.length} product code(s) not found in Product2: ${codeNotFound.join(', ')}`);
  }
  if (codeOutOfScope.length > 0) {
    log(
      `  ${codeOutOfScope.length} product code(s) out of scope (not entitled` +
      `${cfg.includeUnpriced ? '' : ' or not priced'}): ${codeOutOfScope.join(', ')}`,
    );
  }

  let deletes = [];
  if (cfg.productCodeDeletes) {
    const sD = stageStart('deletes');
    const d = await buildDeletes(client, cfg, fullScope);
    deletes = d.deletes;
    sD.done(`${deletes.length} delete documentId(s) from ${cfg.productCodeDeletes.length} product code(s)`);
    if (deletes.length > 0) {
      log(`  Sample documentId: ${deletes[0].documentId}`);
      log('  (must match the indexed documentId exactly — check --site-url)');
    }
    if (d.notFound.length > 0) {
      log(`  ${d.notFound.length} delete code(s) not found in Product2: ${d.notFound.join(', ')}`);
    }
    if (d.duplicates.length > 0) {
      log(`  ${d.duplicates.length} delete code(s) matched several Product2 rows (all deleted): ${d.duplicates.join('; ')}`);
    }
    if (d.variationParents.length > 0) {
      log(
        `  ${d.variationParents.length} delete code(s) are VariationParents, which are never indexed — ` +
        `skipped; their variants were NOT deleted: ${d.variationParents.join('; ')}`,
      );
    }
    if (d.stillExported.length > 0) {
      log(
        `  WARNING: ${d.stillExported.length} delete code(s) still pass the export filters ` +
        `(entitled, ${cfg.includeUnpriced ? '' : 'priced, '}active, active on Parts Store) — ` +
        `the next update run would re-add them: ${d.stillExported.join('; ')}`,
      );
    }

    if (!cfg.deletesOnly) {
      // Never emit a product in both arrays of one payload.
      const dropped = scopeIds.filter((id) => d.deleteIds.has(id));
      if (dropped.length > 0) {
        scopeIds = scopeIds.filter((id) => !d.deleteIds.has(id));
        scope = new Set(scopeIds);
        log(`  ${dropped.length} product(s) being deleted were removed from addOrUpdate`);
      }
    }
  }

  if (cfg.deletesOnly) {
    const writer = createStreamWriter(cfg.output, { includeAddOrUpdate: false });
    await writer.close(deletes);
    log('');
    log(`Wrote ${deletes.length} delete entries (no addOrUpdate) to ${cfg.output}`);
    log('Push with coveo-update.js (incremental). Do NOT use coveo-full-rebuild.js.');
    log(`Total elapsed: ${formatDuration(Date.now() - started)}`);
    return;
  }

  if (scope.size === 0) {
    log('No products in scope. Exiting.');
    const writer = createStreamWriter(cfg.output);
    await writer.close(deletes);
    if (deletes.length > 0) log(`Wrote 0 documents and ${deletes.length} delete entries to ${cfg.output}`);
    return;
  }

  const s6 = stageStart('products');
  const products = await fetchProducts(client, scopeIds, cfg.updatedAfter);
  const dropped = scope.size - products.length;
  // The drop can come from four filters in fetchProducts' SOQL:
  //   - IsActive = false
  //   - Active_on_Parts_Store__c != true (false or null)
  //   - ProductClass = 'VariationParent' (excluded by spec rule #3)
  //   - LastModifiedDate < :updatedAfter (when --updated-after is set)
  const dropNote = dropped > 0 ? ` (${dropped} dropped from scope as inactive, not active on Parts Store, VariationParent, or unchanged)` : '';
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
  const imagesByProduct = buildImageUrlsByProduct(mediaRows, cfg.siteUrl, cfg.customDomain);
  s9.done(`${mediaRows.length} ProductMedia rows, ${imagesByProduct.size} products with images`);

  const s10 = stageStart('assemble');
  const writer = createStreamWriter(cfg.output);
  const unpricedLog = cfg.includeUnpriced ? createUnpricedLog(cfg.output) : null;
  let missingProductCodeCount = 0;
  const missingProductCodeSamples = [];
  let variantCount = 0;
  let simpleCount = 0;
  let unpricedCount = 0;
  let promoCount = 0;

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

    const promoPrice =
      promoPriceByProduct ? (promoPriceByProduct.get(p.Id) ?? null) : null;
    if (promoPriceByProduct && promoPrice != null) promoCount++;

    const doc = buildDocument({
      product: p,
      // productAttr: attrByProduct.get(p.Id) || null,  // revert path: uncomment with the attributes stage above
      categoryPaths: Array.from(pathsByProduct.get(p.Id) || []),
      imageUrls: imagesByProduct.get(p.Id) || null,
      price,
      promoPrice,
      emitPromoPrice: promoPriceByProduct !== null,
      variantParentId,
      siteUrl: cfg.siteUrl,
      brand: cfg.brand,
      includeUnpriced: cfg.includeUnpriced,
    });
    writer.write(doc);
  }

  const count = await writer.close(deletes);
  if (unpricedLog) await unpricedLog.close();
  const unpricedSuffix = cfg.includeUnpriced ? `; ${unpricedCount} without PricebookEntry` : '';
  const promoSuffix = cfg.promoPricebookId ? `; ${promoCount} with promo price` : '';
  s10.done(
    `${count} documents written (${simpleCount} Simple, ${variantCount} Variation${unpricedSuffix}${promoSuffix})`,
  );

  if (missingProductCodeCount > 0) {
    log('');
    log(
      `WARNING: ${missingProductCodeCount} product(s) missing ProductCode — fell back to Id for ec_product_id.`,
    );
    log(`  Sample Ids: ${missingProductCodeSamples.join(', ')}`);
  }

  log('');
  log(`Wrote ${count} documents${deletes.length > 0 ? ` and ${deletes.length} delete entries` : ''} to ${cfg.output}`);
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
