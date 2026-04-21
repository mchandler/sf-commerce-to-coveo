'use strict';

const fs = require('fs');
const path = require('path');

const USAGE = `Usage:
  node export-products.js \\
    --site-url <url> --brand <name> --pricebook-id <id> \\
    --sf-org <alias> --webstore-id <id> --policy-id <id> \\
    --output <path> [options]

Required:
  --site-url <url>       Storefront URL prefix for documentId/clickUri/images
  --brand <name>         Value for ec_brand (emitted as single-element array)
  --pricebook-id <id>    Pricebook whose PricebookEntry rows supply ec_price
  --sf-org <alias>       SF CLI org alias used for authentication
  --webstore-id <id>     WebStore Id; used to derive the product catalog
  --policy-id <id>       CommerceEntitlementPolicy Id for entitlement filter
  --output <path>        Path to write the generated JSON file

Options:
  --updated-after <iso>  ISO-8601 datetime; restrict to products with
                         LastModifiedDate >= :date
  --limit <n>            Cap the number of products output (smoke-test aid)
  --include-unpriced     Emit documents for entitled products even when they
                         lack a PricebookEntry (price defaults to 0); writes
                         a sidecar CSV of unpriced products
  -h, --help             Show this help
`;

const SF_ID_RE = /^[a-zA-Z0-9]{15}$|^[a-zA-Z0-9]{18}$/;
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

function fail(msg) {
  console.error(msg);
  console.error('');
  console.error(USAGE);
  process.exit(1);
}

function takeValue(argv, i, flag) {
  const v = argv[i + 1];
  if (v == null || v.startsWith('--')) fail(`${flag} requires a value`);
  return v;
}

function parseArgs(argv) {
  const out = {
    siteUrl: null,
    brand: null,
    pricebookId: null,
    sfOrg: null,
    webstoreId: null,
    policyId: null,
    output: null,
    updatedAfter: null,
    limit: null,
    includeUnpriced: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--site-url':      out.siteUrl = takeValue(argv, i++, a); break;
      case '--brand':         out.brand = takeValue(argv, i++, a); break;
      case '--pricebook-id':  out.pricebookId = takeValue(argv, i++, a); break;
      case '--sf-org':        out.sfOrg = takeValue(argv, i++, a); break;
      case '--webstore-id':   out.webstoreId = takeValue(argv, i++, a); break;
      case '--policy-id':     out.policyId = takeValue(argv, i++, a); break;
      case '--output':        out.output = takeValue(argv, i++, a); break;
      case '--updated-after': out.updatedAfter = takeValue(argv, i++, a); break;
      case '--limit':         out.limit = parseInt(takeValue(argv, i++, a), 10); break;
      case '--include-unpriced': out.includeUnpriced = true; break;
      case '-h':
      case '--help':
        console.log(USAGE);
        process.exit(0);
      default:
        fail(`Unknown argument: ${a}`);
    }
  }

  return out;
}

function resolveConfig(argv) {
  const cfg = parseArgs(argv);

  if (!cfg.siteUrl) fail('Missing --site-url');
  if (!cfg.brand) fail('Missing --brand');
  if (!cfg.pricebookId) fail('Missing --pricebook-id');
  if (!cfg.sfOrg) fail('Missing --sf-org');
  if (!cfg.webstoreId) fail('Missing --webstore-id');
  if (!cfg.policyId) fail('Missing --policy-id');
  if (!cfg.output) fail('Missing --output');

  if (!SF_ID_RE.test(cfg.pricebookId)) fail(`--pricebook-id is not a valid SF Id: ${cfg.pricebookId}`);
  if (!SF_ID_RE.test(cfg.webstoreId)) fail(`--webstore-id is not a valid SF Id: ${cfg.webstoreId}`);
  if (!SF_ID_RE.test(cfg.policyId)) fail(`--policy-id is not a valid SF Id: ${cfg.policyId}`);

  if (cfg.updatedAfter != null && !ISO_8601_RE.test(cfg.updatedAfter)) {
    fail(`--updated-after must be ISO-8601 (e.g., 2026-04-20T00:00:00Z): ${cfg.updatedAfter}`);
  }

  if (cfg.limit != null && (!Number.isInteger(cfg.limit) || cfg.limit < 1)) {
    fail(`--limit must be a positive integer: ${cfg.limit}`);
  }

  cfg.siteUrl = cfg.siteUrl.replace(/\/$/, '');
  cfg.output = path.resolve(process.cwd(), cfg.output);

  const outDir = path.dirname(cfg.output);
  if (!fs.existsSync(outDir)) fail(`Output directory does not exist: ${outDir}`);

  return cfg;
}

module.exports = { resolveConfig, USAGE };
