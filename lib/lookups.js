'use strict';

const { PRODUCT2_FIELDS, PRODUCTATTRIBUTE_FIELDS, PART_SHORT_DESC_FIELD } = require('./field-mapping');
const { sleep } = require('./http');

const ID_CHUNK_SIZE = 200;
const SOQL_PACE_MS = 100;

function escapeSoqlValue(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function idList(ids) {
  return ids.map((id) => `'${escapeSoqlValue(id)}'`).join(',');
}

async function queryChunked(client, buildSoql, ids, paceMs = SOQL_PACE_MS) {
  const unique = Array.from(new Set(ids));
  const out = [];
  for (let i = 0; i < unique.length; i += ID_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + ID_CHUNK_SIZE);
    const soql = buildSoql(idList(chunk));
    const rows = await client.queryAll(soql);
    out.push(...rows);
    if (paceMs > 0 && i + ID_CHUNK_SIZE < unique.length) await sleep(paceMs);
  }
  return out;
}

async function fetchCatalogIdForWebStore(client, webstoreId) {
  const soql =
    `SELECT ProductCatalogId FROM WebStoreCatalog ` +
    `WHERE SalesStoreId = '${escapeSoqlValue(webstoreId)}' LIMIT 1`;
  const rows = await client.queryAll(soql);
  if (rows.length === 0) {
    throw new Error(`No WebStoreCatalog row found for WebStore ${webstoreId}`);
  }
  return rows[0].ProductCatalogId;
}

async function fetchEntitledProductIds(client, policyId) {
  const soql =
    `SELECT ProductId FROM CommerceEntitlementProduct ` +
    `WHERE PolicyId = '${escapeSoqlValue(policyId)}'`;
  const rows = await client.queryAll(soql);
  return new Set(rows.map((r) => r.ProductId));
}

async function fetchPriceByProductId(client, pricebookId) {
  const soql =
    `SELECT Product2Id, UnitPrice FROM PricebookEntry ` +
    `WHERE Pricebook2Id = '${escapeSoqlValue(pricebookId)}' AND IsActive = true`;
  const rows = await client.queryAll(soql);
  const map = new Map();
  for (const r of rows) map.set(r.Product2Id, r.UnitPrice);
  return map;
}

async function fetchVariantParentMap(client) {
  const soql =
    `SELECT ProductId, VariantParentId FROM ProductAttribute ` +
    `WHERE VariantParentId != null`;
  const rows = await client.queryAll(soql);
  const map = new Map();
  for (const r of rows) {
    if (r.ProductId && r.VariantParentId) map.set(r.ProductId, r.VariantParentId);
  }
  return map;
}

async function fetchProducts(client, ids, updatedAfter) {
  const customFields = Object.values(PRODUCT2_FIELDS).join(', ');
  return queryChunked(client, (inList) => {
    // ProductClass IN ('Simple','Variation') excludes VariationParent per
    // spec rule #3 — indexing parents alongside their children would produce
    // duplicate-looking search results in Coveo.
    let soql =
      `SELECT Id, Name, ProductCode, StockKeepingUnit, Description, ` +
      `${PART_SHORT_DESC_FIELD}, ProductClass, ${customFields} ` +
      `FROM Product2 WHERE Id IN (${inList}) AND IsActive = true ` +
      `AND ProductClass IN ('Simple', 'Variation')`;
    if (updatedAfter) soql += ` AND LastModifiedDate >= ${updatedAfter}`;
    return soql;
  }, ids);
}

async function fetchVariantAttributes(client, variantIds) {
  if (variantIds.length === 0) return [];
  const customFields = Object.values(PRODUCTATTRIBUTE_FIELDS).join(', ');
  return queryChunked(client, (inList) =>
    `SELECT ProductId, ${customFields} ` +
    `FROM ProductAttribute WHERE ProductId IN (${inList})`,
    variantIds,
  );
}

async function fetchCategoriesForCatalog(client, catalogId) {
  const soql =
    `SELECT Id, Name, ParentCategoryId FROM ProductCategory ` +
    `WHERE CatalogId = '${escapeSoqlValue(catalogId)}' AND IsNavigational = true`;
  return client.queryAll(soql);
}

async function fetchProductCategoryLinks(client, catalogId) {
  const soql =
    `SELECT ProductId, ProductCategoryId FROM ProductCategoryProduct ` +
    `WHERE ProductCategory.CatalogId = '${escapeSoqlValue(catalogId)}'`;
  return client.queryAll(soql);
}

async function fetchMedia(client, productIds) {
  // Two-query join: ProductMedia.ElectronicMedia dot-walk resolves to
  // ManagedContentInfo on this org and rejects SOQL on any column. Query
  // ProductMedia for ElectronicMediaId + SortOrder, then fetch ManagedContent
  // rows by Id and join in memory. Returns flattened rows:
  //   { ProductId, SortOrder, ContentKey, ContentType }
  if (productIds.length === 0) return [];

  const pmRows = await queryChunked(client, (inList) =>
    `SELECT ProductId, ElectronicMediaId, SortOrder ` +
    `FROM ProductMedia WHERE ProductId IN (${inList})`,
    productIds,
  );
  if (pmRows.length === 0) return [];

  const mediaIds = Array.from(new Set(
    pmRows.map((r) => r.ElectronicMediaId).filter((x) => x != null),
  ));
  const mcRows = await queryChunked(client, (inList) =>
    `SELECT Id, ContentKey, ContentTypeFullyQualifiedName ` +
    `FROM ManagedContent WHERE Id IN (${inList})`,
    mediaIds,
  );

  const mcById = new Map();
  for (const r of mcRows) mcById.set(r.Id, r);

  const joined = [];
  for (const pm of pmRows) {
    const mc = mcById.get(pm.ElectronicMediaId);
    if (!mc) continue;
    joined.push({
      ProductId: pm.ProductId,
      SortOrder: pm.SortOrder,
      ContentKey: mc.ContentKey,
      ContentType: mc.ContentTypeFullyQualifiedName,
    });
  }
  return joined;
}

module.exports = {
  fetchCatalogIdForWebStore,
  fetchEntitledProductIds,
  fetchPriceByProductId,
  fetchVariantParentMap,
  fetchProducts,
  fetchVariantAttributes,
  fetchCategoriesForCatalog,
  fetchProductCategoryLinks,
  fetchMedia,
};
