# Salesforce B2B Commerce → Coveo Product Catalog

Node.js CLIs for generating a Coveo-ready product catalog JSON from Salesforce B2B Commerce data and pushing it into a Coveo push source.

Three scripts, one per phase:

| Script | Purpose |
|---|---|
| `export-products.js` | Generate the Coveo payload JSON from Salesforce |
| `coveo-update.js` | Push a payload incrementally (adds/updates/deletes without wiping the source) |
| `coveo-full-rebuild.js` | Push a payload as a full rebuild (destructive — any document not in the payload is deleted from the index) |

## Prerequisites

- Node.js 18+
- SF CLI installed and authenticated to the target org: `sf org login web --alias <name>` (only needed for `export-products.js`)
- A Coveo API key with Push rights on the target source (only needed for `coveo-update.js` and `coveo-full-rebuild.js`)

## Install

```
npm install
```

(No third-party dependencies — `npm install` just writes `package-lock.json`.)

## 1. Generate the catalog JSON — `export-products.js`

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
| `--updated-after` | No | ISO-8601 datetime. Restrict output to products with `LastModifiedDate >= :date` |
| `--limit` | No | Cap the number of products for smoke-testing. Applied after scope filtering; samples randomly when trimmed. |
| `--include-unpriced` | No | Emit documents for entitled products even when no active `PricebookEntry` exists; missing prices default to `0`. Also writes a sidecar `<output-basename>-unpriced.csv` listing every such product. Useful for surfacing gaps in the pricebook. |

### Output

- `<output>.json` — the Coveo payload, shaped as `{ "addOrUpdate": [ ... ] }`
- `<output-basename>-unpriced.csv` — sidecar CSV of unpriced products (only when `--include-unpriced` is set and at least one product is unpriced)
- Stderr log — stage-level counts, timing, and per-product warnings

## 2. Incremental push — `coveo-update.js`

Uploads an existing payload as an incremental update to a Coveo push source. Documents in the file are added or updated; **documents already in the source but not in the file are left alone**. Pair with `export-products.js --updated-after` for recurring delta runs.

```
node coveo-update.js \
  --input ./coveo-export.json \
  --org-id <coveo-org-id> \
  --source-id <coveo-source-id> \
  --api-key <coveo-api-key>
```

### Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `--input` | Yes | Path to the Coveo payload JSON (from `export-products.js`) |
| `--org-id` | Yes | Coveo organization Id |
| `--source-id` | Yes | Coveo push source Id |
| `--api-key` | No* | Coveo API key with Push rights. Falls back to the `COVEO_API_KEY` env var if omitted. *One of the two is required. |
| `--region` | No | Coveo platform region: `us` (default), `eu`, `au`, `ca` |
| `--dry-run` | No | Validate the input and print the plan; do not push. |

### Flow

1. `POST /push/v1/organizations/{orgId}/files` → obtain pre-signed S3 upload URL and `fileId`
2. `PUT <uploadUri>` → upload the JSON content
3. `PUT /push/v1/organizations/{orgId}/sources/{sourceId}/stream/update?fileId=...` → apply the update

## 3. Full rebuild — `coveo-full-rebuild.js`

**Destructive.** Replaces the contents of the Coveo source with the supplied payload. Any document currently in the source that is not in the payload will be deleted from the index.

Before the push starts, the script will **interactively prompt you to type the source Id** to confirm. That check is re-requested on every run and cannot be satisfied by shell history or re-running the same command.

```
node coveo-full-rebuild.js \
  --input ./coveo-export.json \
  --org-id <coveo-org-id> \
  --source-id <coveo-source-id> \
  --api-key <coveo-api-key>
```

### Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `--input` | Yes | Path to the Coveo payload JSON |
| `--org-id` | Yes | Coveo organization Id |
| `--source-id` | Yes | Coveo push source Id (type this at the confirm prompt) |
| `--api-key` | No* | Coveo API key with Push rights. Falls back to the `COVEO_API_KEY` env var if omitted. *One of the two is required. |
| `--region` | No | Coveo platform region: `us` (default), `eu`, `au`, `ca` |
| `--dry-run` | No | Validate the input and print the plan; do not prompt, do not push. |

### Flow

1. Interactive confirm prompt (typed source Id must match `--source-id`)
2. `POST .../status?statusType=REBUILD` — mark the source as rebuilding
3. `POST .../stream/open` → obtain `streamId`, `uploadUri`, `fileId`
4. `PUT <uploadUri>` → upload the JSON content
5. `POST .../stream/{streamId}/close` → commit the replace-all
6. `POST .../status?statusType=IDLE` — return the source to normal state

If a step after `stream/open` fails, the script prints the `streamId` so you can clean up the orphan stream manually in the Coveo console. The source may be stuck in `REBUILD` status until resolved.

### Size limit

Coveo enforces a 256 MB hard cap per file container. If your payload exceeds that, the script fails loud — chunking is not implemented in this version.

## Windows PowerShell

Same commands. Requires Node 18+.
