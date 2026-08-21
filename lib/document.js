'use strict';

const {
  PRODUCT2_FIELDS,
  PRODUCTATTRIBUTE_FIELDS, // eslint-disable-line no-unused-vars
  ATTRIBUTE_FIELDS_FROM_PRODUCT2,
  PART_SHORT_DESC_FIELD,
} = require('./field-mapping');

const IMAGE_URL_SUFFIX = '?version=1.1';

// Cloudflare image-transform options, injected between /cdn-cgi/image/ and the
// storefront path.
//
// DEFAULT is the Saltbox form every *.my.site.com storefront has always used.
//
// CLOUDFLARE_FRIENDLY is the option set the PDP uses. On a custom domain the
// bare `format=auto` transform returns 403 and every image breaks; these
// options are known-good there. The load-bearing one is `onerror=redirect`,
// which tells Cloudflare to serve the untransformed origin image when the
// transform fails — so a rejected transform degrades to a working image
// instead of a 403. `fit=scale-down` never upscales, making width an upper
// bound rather than a resize.
const DEFAULT_TRANSFORM = 'format=auto';
const CLOUDFLARE_FRIENDLY_TRANSFORM = 'fit=scale-down,format=auto,onerror=redirect,width=500';

function buildImageUrl(siteUrl, contentKey, cloudflareFriendly = false) {
  // Split the storefront path segment (if present) off siteUrl so the transform
  // prefix sits at the host root, then re-insert the segment after it:
  // {origin}/cdn-cgi/image/{transform}/{storefrontPath}/sfsites/...
  // A custom domain mapped at the root simply has no segment to re-insert.
  const m = siteUrl.match(/^(https?:\/\/[^/]+)(\/.*)?$/);
  if (!m) return null;
  const origin = m[1];
  const pathPrefix = (m[2] || '').replace(/^\//, '');
  const storefrontSegment = pathPrefix ? `${pathPrefix}/` : '';
  const transform = cloudflareFriendly ? CLOUDFLARE_FRIENDLY_TRANSFORM : DEFAULT_TRANSFORM;
  return `${origin}/cdn-cgi/image/${transform}/${storefrontSegment}sfsites/c/cms/delivery/media/${contentKey}${IMAGE_URL_SUFFIX}`;
}

function splitMultiValue(v) {
  if (v == null) return null;
  const s = String(v);
  if (!s.includes(';')) return s;
  return s.split(';').map((x) => x.trim()).filter((x) => x !== '');
}

function buildDocument({
  product,
  // productAttr,  // unused while attribute source = Product2; see note below
  categoryPaths,
  imageUrls,
  price,
  promoPrice,
  emitPromoPrice,
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

  // Attribute source currently = Product2 (per data-team guidance; see
  // lib/field-mapping.js notes). The commented block below reads from the
  // ProductAttribute record via the `productAttr` param and is the revert
  // path if we need to switch back.
  for (const [coveoKey, sfField] of Object.entries(ATTRIBUTE_FIELDS_FROM_PRODUCT2)) {
    doc[coveoKey] = splitMultiValue(product[sfField]);
  }
  // for (const [coveoKey, sfField] of Object.entries(PRODUCTATTRIBUTE_FIELDS)) {
  //   doc[coveoKey] = productAttr ? splitMultiValue(productAttr[sfField]) : null;
  // }

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

  // Shoppable__c = false products stay in the index but must carry NO price:
  // both ec_price and ec_promo_price are omitted (keys never set) even when a
  // PricebookEntry exists. Omitting rather than emitting null keeps a single
  // "no price" representation consistent with the unpriced path below, and
  // the incremental stream/update flow replaces whole documents so there is
  // no stale value to clear. Shoppable__c is a checkbox (never null); only an
  // explicit false suppresses pricing.
  const shoppable = product.Shoppable__c !== false;

  if (shoppable) {
    if (price != null) {
      doc.ec_price = price;
    } else if (includeUnpriced) {
      doc.ec_price = 0;
    }

    if (emitPromoPrice) {
      doc.ec_promo_price = promoPrice;
    }
  }

  doc.ec_category = categoryPaths && categoryPaths.length > 0 ? categoryPaths : [];
  doc.ec_in_stock = 'In Stock';
  doc.permissions = [{ allowAnonymous: true }];

  return doc;
}

module.exports = { buildDocument, buildImageUrl };
