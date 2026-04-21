# Coveo Product Import — Node Script (Scoping)

## Why This Is Needed

The Saltbox to Coveo Transformer produces a JSON payload for pushing
products to Coveo, but as of 2026-04-21 testing it has gaps that make
it insufficient for a full-catalog facet-filtering rollout. The
primary blocker:

- **Saltbox does not include variant children.** This is the single
  most important gap driving the need for a replacement. The
  representative Saltbox export
  `b2b-info/coveo-export-1776788929580.json` contains 8,018 documents
  and **zero variant children** — every document is a Simple product.
  Our facet-filter work depends on variants being indexed with their
  attribute values (color, handing, etc.), and Saltbox cannot produce
  them. This is why a replacement script is being scoped.

Additional gaps that a replacement script would also resolve:

- **Variant grouping not emitted** — Saltbox never emits
  `ec_item_group_id`, so even if variant children were included they
  would not group to their parent in Coveo.
- **Pricing nearly absent** — `ec_price` appears on only **11 of
  8,018** documents (~0.14%). The majority of the catalog arrives in
  Coveo unpriced.
- **Missing baseline fields** — `ec_shortdesc`, `clickUri`, and
  `fileExtension` are not emitted.
- **Non-standard multi-value encodings** — `ec_category` uses ` ; `
  (space-semicolon-space) to join paths into a single string instead
  of emitting a JSON array of strings. `ec_works_with` similarly uses
  `;` to flatten multi-picklist values. This likely works because
  Coveo's field definitions can be multi-value strings, but it
  diverges from the array shape our Apex push scripts use.

This document scopes a **Node.js script** that would generate the
equivalent Coveo-ready JSON from Salesforce data directly, filling
those gaps. It is not yet a decision to build — it is a specification
we can execute against if Saltbox continues to be unreliable.

## Reference

- **Saltbox sample export**: `b2b-info/coveo-export-1776788929580.json`
  — 15 MB, 8,018 documents. Retained for reference.
- **Existing Apex bulk import**:
  `b2b-scripts/CoveoBulkIndexAllProducts.apex` and
  `force-app/main/default/classes/ECOM_CoveoBatchProductIndex.cls`
  — these produce the baseline 10-field shape but not the extended
  attribute fields and are not scoped to "truly entitled" products.
- **Successful sample push (variants)**:
  `b2b-scripts/CoveoUpdateProducts-ecommpilot-CasementHandle.apex` —
  a proof that variant children can be pushed via the Coveo Stream
  API update endpoint with extended attribute fields populated.

## CLI Interface

The script should accept the following arguments:

| Argument | Example | Purpose |
| -------- | ------- | ------- |
| `--site-url` | `https://andersen--ecommpilot.sandbox.my.site.com/AndersenPartsStore` | Prefix for `documentId`, `clickUri`, and any URL-based field values. |
| `--brand` | `Andersen` | Value to use for `ec_brand`. |
| `--pricebook-id` | `01sWr000001MTHKIA4` | Pricebook whose `PricebookEntry` rows supply `ec_price`. |
| `--sf-org` | `ecommpilot` | SF CLI org alias used for all SOQL queries via `sf data query`. |
| `--output` | `./coveo-export.json` | Path to write the generated JSON file. |
| `--webstore-id` | `0ZEWr0000003iXZOAY` | (Optional) Andersen Parts Store WebStore Id; used for documentation/logging. |
| `--policy-id` | `1CeWr0000003arlKAA` | `CommerceEntitlementPolicy` Id used to determine entitlement. |
| `--updated-after` | `2026-04-20T00:00:00Z` | (Optional) ISO-8601 datetime. When supplied, restrict output to products with `Product2.LastModifiedDate >= :date`. See [Incremental Runs](#incremental-runs-updated-after) below for semantics. |

The script uses `sf data query --target-org <alias>` for all
Salesforce lookups — no separate auth handling required.

### Incremental Runs (`--updated-after`)

Running the script against the full 25–30K catalog every time is
wasteful once the initial load is in Coveo. The `--updated-after`
argument enables incremental runs — a recurring export containing
only products that changed since the last run.

**Filter applied**: `Product2.LastModifiedDate >= :date`. This is
added to the product-scope SOQL query alongside the existing
entitlement and ProductClass filters.

**Coveo submission pattern**: The output file is still shaped as
`{"addOrUpdate": [...]}` and is submitted via the incremental
`PUT /stream/update?fileId=…` endpoint — **not** via
`stream/open` + `stream/close`. The latter performs a full rebuild
and would delete every document not in the payload, which is
catastrophic for an incremental run.

**Known limitation of this filter**: `Product2.LastModifiedDate`
captures changes to fields on `Product2` itself. It does **not**
capture:

- Changes to **`ProductAttribute`** rows (e.g., a variant's
  `Color_Or_Finish__c` picklist value is updated) — the parent
  `Product2` row is untouched.
- Changes to **`PricebookEntry`** rows (e.g., a price change) —
  `Product2.LastModifiedDate` is not bumped.
- Changes to **`ProductMedia`** rows (a new image is attached) —
  same.
- Changes to **`ProductCategoryProduct`** rows (re-categorization)
  — same.

For v1, the recommendation is to **use `--updated-after` for
product-field changes and periodically run a full export (omit the
arg) to pick up changes in related objects**. A more exhaustive
"truly changed" filter is possible (`OR`-ing multiple
`LastModifiedDate` conditions across the related tables), but it
adds complexity and can be deferred unless the team sees
attribute/price drift as a recurring issue.

**Saltbox parity**: The Saltbox Transformer's "Store Entitlement
Filter" input also supports an updated-after date. This argument
brings the Node script to parity on that capability.

## Product Scope

The script must only emit documents for products that are **truly
entitled to the Andersen Parts Store** AND are meaningful for
shoppers. The scope rules:

1. **Simple products** (`Product2.ProductClass = 'Simple'`) that have:
   - An active `PricebookEntry` in the provided `--pricebook-id`, AND
   - A `CommerceEntitlementProduct` row linking the product to the
     provided `--policy-id`.

2. **Variation child products** (`Product2.ProductClass = 'Variation'`)
   that have:
   - An active `PricebookEntry` in the provided `--pricebook-id`, AND
   - Their `VariationParent` (queried via `ProductAttribute.VariantParentId`)
     has a `CommerceEntitlementProduct` row linking the parent to the
     provided `--policy-id`. Children inherit entitlement from their
     parent.

3. **Variation Parents** (`Product2.ProductClass = 'VariationParent'`):
   **EXCLUDED.** Per decision, parents are not indexed because the
   ecommpilot Commerce catalog is configured with "Object Types:
   Neither Variants nor Availability checked" — indexing parents
   would create duplicate-looking results alongside the children.

## Output Document Shape

The script should emit `{ "addOrUpdate": [ ... ] }` with each document
conforming to the shape below. This is the Saltbox shape augmented
with the missing baseline fields and with multi-value handling that
matches our Apex push scripts.

### Required on Every Document

| Field | Source / Rule |
| ----- | ------------- |
| `documentId` | `{site-url}/product/{slug}/{Product2.Id}` where `{slug}` is the lowercased name with non-alphanumerics replaced by `-`. |
| `clickUri` | Same value as `documentId`. |
| `fileExtension` | Literal `.html`. |
| `objecttype` | Literal `Product`. |
| `ec_product_id` | `Product2.ProductCode` (per Field Mapping Matrix). Saltbox uses `Product2.Id` here — **do not** replicate that; it breaks the ec_product_id convention used by our existing Apex push scripts. |
| `permanentid` | Mirrors `ec_product_id`. |
| `sfid` | `Product2.Id`. |
| `ec_sku` | `Product2.StockKeepingUnit`. |
| `StockKeepingUnit` | `Product2.StockKeepingUnit` (retained for parity with Saltbox export). |
| `ec_name` | `Product2.Name`. |
| `ec_shortdesc` | `Product2.Part_Short_Description__c` — missing from Saltbox but present in our Apex push pattern. |
| `ec_description` | `Product2.Description` (fall back to `Product2.Name` if null). |
| `ec_brand` | Literal `--brand` value as a single-element array: `["Andersen"]`. |
| `ec_price` | **Required on every document that has an active `PricebookEntry` in `--pricebook-id`.** Emit as a number. This is a hard requirement — Saltbox's near-total absence of pricing (11 of 8,018) must be fully resolved by the Node script. Products without an active pricebook entry are either not truly sellable and should be filtered out by the scope rules above, or omit `ec_price` only as a last resort. |
| `ec_category` | Array of pipe-delimited category paths for this product (under the Andersen Parts Store catalog). **Default: emit as a JSON array of strings** (matches our Apex push pattern and the existing baseline documents in the Coveo source). If matching Saltbox's ` ; `-joined single-string form simplifies some other tooling, switching is acceptable — both formats are Coveo-valid for multi-value fields. The array form has one safety advantage: it avoids ambiguity if a category name ever contains a literal `;`. |
| `ec_images` | Array of CMS-backed image URLs — see Image Sourcing below. |
| `ec_thumbnails` | Same as `ec_images` for initial rollout. |
| `ec_item_group_id` | For variant children: the parent `Product2.Id`. For simple products: omit. Saltbox never emits this; the script must. |
| `ec_in_stock` | `"In Stock"` literal for initial rollout (mirrors Saltbox). Future: tie to real inventory. |
| `permissions` | `[{ "allowAnonymous": true }]`. |

### Extended Attribute Fields (the 25 `ec_*` facet fields)

Emit each of the 25 Field-Mapping-Matrix fields. Source per the Matrix:

- **15 from `ProductAttribute`** (child-to-parent inherit path):
  `ec_color_or_finish`, `ec_door_style`, `ec_exterior_color`,
  `ec_glass_type`, `ec_grille_style`, `ec_grille_type`,
  `ec_handing`, `ec_interior_color`, `ec_notched`,
  `ec_operator_style`, `ec_sash_ratio`, `ec_tempered`,
  `ec_visible_glass_height`, `ec_visible_glass_width`,
  `ec_weather_stripping`.
- **10 from `Product2`** (direct):
  `ec_balancer_number`, `ec_closer_type`, `ec_fastener_type`,
  `ec_insect_screen_height`, `ec_insect_screen_width`,
  `ec_install_method`, `ec_product_style`, `ec_series`,
  `ec_vintage`, `ec_works_with`.

For multi-picklist sources, serialize as JSON arrays (e.g., `["A","B"]`)
rather than Saltbox's `;`-joined strings.

For variant children, pull ProductAttribute-sourced values from the
child's own `ProductAttribute` record. For Simple products (which
don't have ProductAttribute records), these 15 values will be null
or omitted.

### Image Sourcing

The Saltbox export uses URLs of the form:

```
{site-url}/cdn-cgi/image/format=auto/AndersenPartsStore/sfsites/c/cms/delivery/media/{contentKey}?version=1.1
```

These are Cloudflare-transformed references to CMS-managed images.
The Node script should query `ProductMedia` and derive these URLs for
each product. Only 3,498 of 8,018 Saltbox documents carry images —
the script can match that scope (only emit `ec_images` when images
exist) without treating it as a gap.

## SOQL Queries the Script Will Run

Outline of the queries the script will issue via `sf data query
--target-org <alias>`:

1. **Entitled parents**: `SELECT ProductId FROM CommerceEntitlementProduct
   WHERE PolicyId = :policyId`. Build an in-memory set of entitled
   Product2 Ids.

2. **In-pricebook products**: `SELECT Product2Id, UnitPrice FROM
   PricebookEntry WHERE Pricebook2Id = :pricebookId AND IsActive = true`.
   Build a map of Product2.Id → price.

3. **Variant-to-parent map**: `SELECT ProductId, VariantParentId FROM
   ProductAttribute WHERE VariantParentId != null`. Build a map of
   child Product2.Id → parent Product2.Id.

4. **Product details**: `SELECT Id, Name, ProductCode, StockKeepingUnit,
   Description, Part_Short_Description__c, ProductClass,
   <10 Product2 attribute fields>
   FROM Product2 WHERE Id IN :scope AND IsActive = true`.
   Where `:scope` is the filtered set of Simple + entitled-variant Ids.
   If `--updated-after` is supplied, append
   `AND LastModifiedDate >= :date` to this query.

5. **Variant attribute values**: `SELECT ProductId, <15 ProductAttribute
   fields> FROM ProductAttribute WHERE ProductId IN :variantIds`.

6. **Category paths**: `SELECT ProductCategory.Id, ParentCategoryId,
   Name, ParentCategory.Name, …, IsNavigational FROM ProductCategory
   WHERE CatalogId = :partsStoreCatalogId AND IsNavigational = true`
   followed by `SELECT ProductId, ProductCategoryId FROM
   ProductCategoryProduct WHERE ProductCategory.CatalogId =
   :partsStoreCatalogId`. Variant children inherit their parent's
   categories; the script must merge parent's categories onto each
   child document.

7. **Product images**: `SELECT ProductId, ElectronicMediaId, SortOrder
   FROM ProductMedia WHERE ProductId IN :scope`, then resolve the CMS
   content identifier to a deliverable URL pattern.

## Key Deltas vs. the Saltbox Output

| Item | Saltbox | Node script |
| ---- | ------- | ----------- |
| Includes variant children? | No | **Yes** |
| Emits `ec_item_group_id`? | No | **Yes** (parent Id on each child) |
| Coverage of `ec_price` | 11 / 8,018 | Every in-pricebook product |
| Emits `ec_shortdesc`? | No | **Yes** |
| Emits `clickUri` / `fileExtension`? | No | **Yes** |
| `ec_category` shape | ` ; `-joined string | JSON array of strings |
| Multi-picklist shape (e.g., `ec_works_with`) | `;`-joined string | JSON array |
| `ec_product_id` for Simple products | `Product2.Id` | `Product2.ProductCode` |
| Entitlement filter | Unknown / apparently catalog-based | Policy + pricebook (+ parent inheritance) |

## Open Questions Before Implementation

1. **Should we also mirror `ec_sku` and `StockKeepingUnit`?** Saltbox
   emits both as duplicates of ProductCode/SKU. Whether Coveo uses
   these in practice on the storefront is worth confirming before
   replicating.
2. **Output delivery**: should the Node script also call the Coveo
   Stream API (`stream/open` / `stream/update`), or is its job purely
   to produce the JSON file that is then handed off manually? The
   Apex scripts already handle the Push API flow; the Node script
   may be cleaner if it stays file-oriented.
3. **Does `Part_Short_Description__c` exist on the `ecommpilot` org
   for the full Parts Store catalog?** We've confirmed it's the
   source field for `ec_shortdesc` in Apex scripts, but population
   rates should be spot-checked.
4. **Image URL derivation**: does the Saltbox URL pattern (`/cdn-cgi/image/format=auto/AndersenPartsStore/sfsites/c/cms/delivery/media/{key}?version=1.1`)
   hold for all CMS-backed product images, or is there an
   image-strategy pivot coming that could invalidate this pattern?
   The consolidation doc's "Product Image Strategy (DEFERRED)"
   section suggests the source URL is expected to change.

## Volume Considerations (25–30K Products)

The target Parts Store catalog is expected to reach **25,000–30,000
products** once fully populated. The Saltbox export of ~8,000 Simple
products is about 15 MB; a full export including variants at the
target scale will be meaningfully larger and needs to be designed for
from the start.

Rough projected footprint at 30K products:

| Data | Estimated rows | Notes |
| ---- | -------------- | ----- |
| `Product2` records | 30K | Simple + Variant children |
| `PricebookEntry` rows | ~30K | One per product in `--pricebook-id` |
| `ProductAttribute` rows | Variable (~10–20K) | One per variant child |
| `ProductCategoryProduct` rows | 50K–150K | Products cross-listed in multiple categories |
| `ProductMedia` rows | 60K–200K | Multiple images per product |
| Output JSON file size | 50–100 MB | Up from ~15 MB at 8K Simple-only |
| Peak in-memory footprint (naive approach) | 1.5–3 GB | If all joins are held in memory |

### Salesforce Interaction Strategy

- **Use Bulk API v2 for large queries.** Pass `--bulk` (or
  `--use-tooling-api` where applicable) on any `sf data query` that
  is expected to return more than ~20K rows. `ProductCategoryProduct`
  and `ProductMedia` will both exceed that. Bulk API v2 returns
  results via a file download rather than in-memory REST
  paginate-loops, which is more predictable at volume.
- **One SOQL per data type, joined in memory.** Do NOT fetch
  per-product. Every query should pull its entire result set once,
  then be keyed into a `Map` for O(1) joins when assembling
  documents. Target total query count: 6–8 large queries, not 30K
  small ones.
- **Respect governor-adjacent limits on the client side.** Even
  though SOQL via CLI isn't subject to Apex governor limits, the
  REST query limit is 50K rows per page and the query-string length
  limit is ~20K characters. If a subquery literal would exceed that,
  rewrite as a correlated subquery (`Id IN (SELECT … FROM …)`) or
  break into ranges.
- **Expect a multi-minute run.** A typical full-catalog pull of this
  shape takes 2–5 minutes depending on Bulk API job latency. Log
  timestamps and row counts at each stage so progress is visible.

### Memory and Output Strategy

The naive "load everything, assemble array in memory, stringify once,
write" pattern will comfortably exceed 1 GB of Node heap at 30K
products with all joins. To stay well within default Node heap
(~1.5 GB), use a **chunked streaming approach**:

- **Stream the output file** using `fs.createWriteStream`. Manually
  write the `{ "addOrUpdate": [` prefix, serialize each product
  document individually with a trailing `,` between entries, then
  write the closing `] }`. Each document is independent JSON — they
  do not need to be held in a single in-memory array.
- **Process products in chunks** of ~1,000–2,000 records. For each
  chunk:
  1. Build its documents using the pre-loaded lookup maps for
     pricing, categories, attributes, and media.
  2. Serialize and append to the output stream.
  3. Release the chunk's document objects (let GC reclaim).
- **Load lookup data once, per-product data lazily.** Pricing,
  category hierarchy, entitlement policy membership, and media URLs
  should be loaded up-front into `Map` structures. Product2 rows
  themselves can be streamed from Bulk API results rather than
  fully buffered.
- **Consider `--result-format csv` for Bulk API responses** —
  Node's `csv-parse` (or a simple line-by-line split) streams
  result rows without requiring the full result set in memory.

### Execution Time and Observability

- Budget 3–6 minutes for a full-catalog export at 30K products:
  ~1 min of query waits (Bulk API job start/stop), ~2–4 min of
  result streaming and document assembly.
- Emit progress logs at each stage (e.g., "Fetched 27,431
  PricebookEntry rows", "Assembling documents: chunk 14 / 30").
  A silent multi-minute process is frustrating to debug and gives
  no confidence during a production run.
- Log the final document count and output file size. If the run
  completes in seconds, that's a signal something went wrong
  upstream (empty query result, bad alias).

## Next Step

Build time/effort estimate if the team chooses to commit. The script
itself is straightforward — CLI parsing, SF CLI invocation, SOQL
result joining, and streamed JSON assembly — probably a **3–4 day
effort** for a working version scoped to `ecommpilot` with the
volume-aware strategy above. Extending to andersentest and
andersenstage adds minimal effort since only the CLI arguments
change; the script's data-handling design doesn't change per
environment.
