# Salesforce B2B Commerce → Coveo Product Catalog

Node.js CLI that generates a Coveo-ready product catalog JSON from Salesforce B2B Commerce data. Replaces the Saltbox-to-Coveo Transformer, closing its gaps: includes variant children, emits `ec_item_group_id` for variant grouping, populates `ec_price` on every in-pricebook product, emits `ec_shortdesc` / `clickUri` / `fileExtension`, and uses JSON arrays for multi-value fields.

Design spec: [`Coveo-Product-Import-NodeScript.md`](./Coveo-Product-Import-NodeScript.md).

## Prerequisites

- Node.js 18+
- SF CLI installed and authenticated to the target org: `sf org login web --alias <name>`

## Install

```
npm install
```

(No third-party dependencies — `npm install` just writes `package-lock.json`.)

## Usage

```
node export-products.js \
  --site-url https://myorg--sandbox.sandbox.my.site.com/MyStore \
  --brand Nabisco \
  --pricebook-id 01sXXXXXXXXXXXXXXX \
  --sf-org MySFOrg \
  --webstore-id 0ZEXXXXXXXXXXXXXXX \
  --policy-id 1CeXXXXXXXXXXXXXXX \
  --output ./coveo-export.json
```

### Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `--site-url` | Yes | Storefront URL prefix for `documentId` / `clickUri` / image URLs |
| `--brand` | Yes | Value emitted in `ec_brand` |
| `--pricebook-id` | Yes | Pricebook whose `PricebookEntry` rows supply `ec_price` |
| `--sf-org` | Yes | SF CLI org alias used for authentication |
| `--webstore-id` | Yes | WebStore Id; used to derive the product catalog scope |
| `--policy-id` | Yes | `CommerceEntitlementPolicy` Id used to determine entitlement |
| `--output` | Yes | Path to write the generated JSON file |
| `--updated-after` | No | ISO-8601 datetime. Restrict output to products with `LastModifiedDate >= :date` (see spec §Incremental Runs) |
| `--limit` | No | Cap the number of products for smoke-testing. Applied after scope filtering. |

## Output

A single JSON file shaped as `{ "addOrUpdate": [ ... ] }`. Push to Coveo via either:

- **Full rebuild** — `stream/open` → `stream/chunk` → `stream/close` (destructive; deletes missing docs)
- **Incremental** — `PUT /stream/update?fileId=...` (pair with `--updated-after`)

This script only generates the file; pushing is a separate step.

## Output Artifacts

- `<output>.json` — the Coveo payload
- Stderr log — stage-level counts, timing, and any per-product warnings

## Windows PowerShell

Same commands. Requires Node 18+.
