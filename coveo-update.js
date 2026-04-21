#!/usr/bin/env node
'use strict';

const fs = require('fs');

const { resolveCoveoConfig } = require('./lib/coveo-args');
const { createCoveoClient, CoveoError, MAX_FILE_BYTES } = require('./lib/coveo-client');
const { log, stageStart, formatDuration } = require('./lib/progress');

const USAGE = `Usage:
  node coveo-update.js \\
    --input <path> --org-id <id> --source-id <id> \\
    [--api-key <key>] [--region us|eu|au|ca] [--dry-run]

Performs an incremental push of an existing {"addOrUpdate":[...],"delete":[...]}
JSON file into a Coveo push source. Existing documents not in the payload are
NOT affected (unlike a full rebuild).

Required:
  --input <path>       Path to the JSON payload (from export-products.js)
  --org-id <id>        Coveo organization Id
  --source-id <id>     Coveo push source Id

Options:
  --api-key <key>      Coveo API key with Push rights on the source.
                       Falls back to the COVEO_API_KEY env var if omitted.
  --region <code>      Coveo platform region: us (default), eu, au, ca
  --dry-run            Validate the input and print the plan; do not push.
  -h, --help           Show this help
`;

function loadPayload(inputPath) {
  const bytes = fs.readFileSync(inputPath);
  let doc;
  try {
    doc = JSON.parse(bytes.toString('utf8'));
  } catch (e) {
    throw new Error(`Input is not valid JSON: ${e.message}`);
  }
  const addOrUpdate = Array.isArray(doc.addOrUpdate) ? doc.addOrUpdate : [];
  const del = Array.isArray(doc.delete) ? doc.delete : [];
  if (addOrUpdate.length === 0 && del.length === 0) {
    throw new Error('Input has neither "addOrUpdate" nor "delete" arrays with content — nothing to push.');
  }
  return { bytes, addOrUpdate, del };
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function main() {
  const started = Date.now();
  const cfg = resolveCoveoConfig(process.argv.slice(2), USAGE);

  log(`Mode:        INCREMENTAL UPDATE`);
  log(`Region:      ${cfg.region}`);
  log(`Org:         ${cfg.orgId}`);
  log(`Source:      ${cfg.sourceId}`);
  log(`Input:       ${cfg.input}`);
  log(`Dry-run:     ${cfg.dryRun ? 'yes' : 'no'}`);
  log('');

  const s1 = stageStart('load');
  const { bytes, addOrUpdate, del } = loadPayload(cfg.input);
  s1.done(`${formatBytes(bytes.length)} | ${addOrUpdate.length} addOrUpdate, ${del.length} delete`);

  if (bytes.length > MAX_FILE_BYTES) {
    throw new Error(
      `Input is ${formatBytes(bytes.length)} which exceeds Coveo's ` +
      `${formatBytes(MAX_FILE_BYTES)} per-file limit. Split the payload or ` +
      `use the full-rebuild flow with multi-chunk support.`,
    );
  }

  if (cfg.dryRun) {
    log('');
    log('Dry-run complete. Would perform:');
    log(`  1. POST /push/v1/organizations/${cfg.orgId}/files`);
    log(`  2. PUT <uploadUri> (${formatBytes(bytes.length)})`);
    log(`  3. PUT /push/v1/organizations/${cfg.orgId}/sources/${cfg.sourceId}/stream/update?fileId=<fileId>`);
    log('');
    log('Re-run without --dry-run to actually push.');
    return;
  }

  const client = createCoveoClient(cfg);

  const s2 = stageStart('file-container');
  const container = await client.createFileContainer();
  if (!container || !container.uploadUri || !container.fileId) {
    throw new Error(`Unexpected file-container response: ${JSON.stringify(container).slice(0, 300)}`);
  }
  s2.done(`fileId = ${container.fileId}`);

  const s3 = stageStart('upload');
  await client.putToS3(container.uploadUri, container.requiredHeaders || {}, bytes);
  s3.done(`${formatBytes(bytes.length)} uploaded to S3`);

  const s4 = stageStart('apply-update');
  const updateResp = await client.streamUpdate(container.fileId);
  const respSuffix = updateResp && typeof updateResp === 'object'
    ? ` | orderingId=${updateResp.orderingId || '?'} requestId=${updateResp.requestId || '?'}`
    : '';
  s4.done(`stream/update accepted${respSuffix}`);

  log('');
  log(`Pushed ${addOrUpdate.length} addOrUpdate / ${del.length} delete documents incrementally.`);
  log(`Total elapsed: ${formatDuration(Date.now() - started)}`);
  log('Note: it may take a few minutes for documents to appear in search.');
}

main().catch((err) => {
  console.error('');
  if (err instanceof CoveoError) {
    console.error(`Fatal: Coveo HTTP ${err.status}${err.errorCode ? ` (${err.errorCode})` : ''}`);
    console.error(`  URL:  ${err.url}`);
    if (err.body) console.error(`  Body: ${String(err.body).slice(0, 500)}`);
  } else {
    console.error('Fatal error:', err.message);
  }
  process.exit(2);
});
