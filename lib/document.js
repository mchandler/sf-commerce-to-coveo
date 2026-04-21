'use strict';

const { PRODUCT2_FIELDS, PRODUCTATTRIBUTE_FIELDS, PART_SHORT_DESC_FIELD } = require('./field-mapping');

const IMAGE_URL_SUFFIX = '?version=1.1';

function buildImageUrl(siteUrl, contentKey) {
  // Strip the storefront path segment (if present) from siteUrl so the
  // Cloudflare-transformed prefix lives at the host root: the Saltbox URL
  // form is {origin}/cdn-cgi/image/format=auto/{storefrontPath}/sfsites/...
  const m = siteUrl.match(/^(https?:\/\/[^/]+)(\/.*)?$/);
  if (!m) return null;
  const origin = m[1];
  const pathPrefix = (m[2] || '').replace(/^\//, '');
  const storefrontSegment = pathPrefix ? `${pathPrefix}/` : '';
  return `${origin}/cdn-cgi/image/format=auto/${storefrontSegment}sfsites/c/cms/delivery/media/${contentKey}${IMAGE_URL_SUFFIX}`;
}

function splitMultiValue(v) {
  if (v == null) return null;
  const s = String(v);
  if (!s.includes(';')) return s;
  return s.split(';').map((x) => x.trim()).filter((x) => x !== '');
}

function buildDocument({
  product,
  productAttr,
  categoryPaths,
  imageUrls,
  price,
  variantParentId,
  siteUrl,
  brand,
  includeUnpriced,
}) {
  const productCode = product.ProductCode;
  const ecProductId = productCode || product.Id;
  const documentId = `${siteUrl}/product/${product.Id}`;

  const doc = {
    documentId,
    clickUri: documentId,
    fileExtension: '.html',
    ec_name: product.Name,
    objecttype: 'Product',
    sfid: product.Id,
  };

  if (variantParentId) {
    doc.ec_item_group_id = variantParentId;
  }

  doc.StockKeepingUnit = product.StockKeepingUnit ?? null;

  for (const [coveoKey, sfField] of Object.entries(PRODUCT2_FIELDS)) {
    doc[coveoKey] = splitMultiValue(product[sfField]);
  }

  for (const [coveoKey, sfField] of Object.entries(PRODUCTATTRIBUTE_FIELDS)) {
    doc[coveoKey] = productAttr ? splitMultiValue(productAttr[sfField]) : null;
  }

  doc.ec_product_id = ecProductId;
  doc.permanentid = ecProductId;
  doc.ec_sku = product.StockKeepingUnit ?? null;
  doc.ec_brand = [brand];
  doc.ec_description = product.Description || product.Name;
  doc.ec_shortdesc = product[PART_SHORT_DESC_FIELD] ?? null;

  if (imageUrls && imageUrls.length > 0) {
    doc.ec_thumbnails = imageUrls;
    doc.ec_images = imageUrls;
  }

  if (price != null) {
    doc.ec_price = price;
  } else if (includeUnpriced) {
    doc.ec_price = 0;
  }

  doc.ec_category = categoryPaths && categoryPaths.length > 0 ? categoryPaths : [];
  doc.ec_in_stock = 'In Stock';
  doc.permissions = [{ allowAnonymous: true }];

  return doc;
}

module.exports = { buildDocument, buildImageUrl };
