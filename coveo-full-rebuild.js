#!/usr/bin/env node
'use strict';

const fs = require('fs');
const readline = require('readline');

const { resolveCoveoConfig } = require('./lib/coveo-args');
const { createCoveoClient, CoveoError, MAX_FILE_BYTES } = require('./lib/coveo-client');
const { log, stageStart, formatDuration } = require('./lib/progress');

const USAGE = `Usage:
  node coveo-full-rebuild.js \\
    --input <path> --org-id <id> --source-id <id> \\
    [--api-key <key>] [--region us|eu|au|ca] [--dry-run]

DESTRUCTIVE. Performs a full rebuild of the Coveo push source: any document
not in the payload is DELETED from the index. Use coveo-update.js for
incremental/additive pushes.

Before the push starts, this script will prompt you to type the source Id
to confirm. That interactive step cannot be satisfied by shell history or
re-running the same command.

Required:
  --input <path>       Path to the JSON payload (from export-products.js)
  --org-id <id>        Coveo organization Id
  --source-id <id>     Coveo push source Id (type this at the confirm prompt)

Options:
  --api-key <key>      Coveo API key with Push rights on the source.
                       Falls back to the COVEO_API_KEY env var if omitted.
  --region <code>      Coveo platform region: us (default), eu, au, ca
  --dry-run            Validate the input and print the plan; do not prompt,
                       do not push.
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

function promptForSourceId() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Confirm source ID: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const started = Date.now();
  const cfg = resolveCoveoConfig(process.argv.slice(2), USAGE);

  log(`Mode:        FULL REBUILD (destructive)`);
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
      `${formatBytes(MAX_FILE_BYTES)} per-file limit. Split the payload before pushing.`,
    );
  }

  if (cfg.dryRun) {
    log('');
    log('Dry-run complete. Would perform:');
    log(`  0. Interactive prompt: confirm source ID = ${cfg.sourceId}`);
    log(`  1. POST /push/v1/organizations/${cfg.orgId}/sources/${cfg.sourceId}/stream/open`);
    log(`  2. PUT <uploadUri> (${formatBytes(bytes.length)})`);
    log(`  3. POST /push/v1/organizations/${cfg.orgId}/sources/${cfg.sourceId}/stream/<streamId>/close`);
    log('');
    log('Re-run without --dry-run to actually push.');
    return;
  }

  // Destructive-op banner + interactive confirm. Cannot be bypassed by
  // shell history — each run requires a fresh typed confirmation.
  log('========================================================================');
  log('  DESTRUCTIVE OPERATION — FULL REBUILD');
  log('========================================================================');
  log('This will REPLACE the contents of the Coveo source.');
  log('Any document not in this payload will be DELETED from the index.');
  log('');
  log(`  Source:  ${cfg.sourceId}`);
  log(`  Docs:    ${addOrUpdate.length} addOrUpdate, ${del.length} delete`);
  log(`  Size:    ${formatBytes(bytes.length)}`);
  log('');
  log('To proceed, type the source ID exactly as shown above.');
  log('');

  const typed = await promptForSourceId();
  if (typed !== cfg.sourceId) {
    log('');
    log('Source ID did not match — aborting. No changes made.');
    process.exit(1);
  }
  log('');

  const client = createCoveoClient(cfg);
  let streamId = null;

  try {
    // NOTE: we do NOT call setSourceStatus('REBUILD'/'IDLE') here. Those
    // toggles are from the legacy Push API and return 412
    // SOURCE_IS_STREAM_ENABLED against stream-enabled Catalog sources.
    // stream/open and stream/close manage the source state implicitly.
    const s2 = stageStart('stream-open');
    const opened = await client.streamOpen();
    if (!opened || !opened.streamId || !opened.uploadUri || !opened.fileId) {
      throw new Error(`Unexpected stream/open response: ${JSON.stringify(opened).slice(0, 300)}`);
    }
    streamId = opened.streamId;
    s2.done(`streamId = ${streamId} | fileId = ${opened.fileId}`);

    const s3 = stageStart('upload');
    await client.putToS3(opened.uploadUri, opened.requiredHeaders || {}, bytes);
    s3.done(`${formatBytes(bytes.length)} uploaded to S3`);

    const s4 = stageStart('stream-close');
    const closeResp = await client.streamClose(streamId);
    const respSuffix = closeResp && typeof closeResp === 'object'
      ? ` | orderingId=${closeResp.orderingId || '?'} requestId=${closeResp.requestId || '?'}`
      : '';
    s4.done(`stream closed${respSuffix}`);
    streamId = null; // successfully closed; no cleanup owed

    log('');
    log(`Rebuild complete. ${addOrUpdate.length} documents pushed; source contents replaced.`);
    log(`Total elapsed: ${formatDuration(Date.now() - started)}`);
    log('Note: it may take a few minutes for documents to appear in search.');
  } catch (err) {
    // If stream/open succeeded but a later step failed, the stream is still
    // open on Coveo's side. Surface the streamId so the operator can close
    // it manually via the Coveo console. Orphaned streams are eventually
    // discarded by Coveo, but leaving one open can block subsequent pushes.
    if (streamId) {
      console.error('');
      console.error(`WARNING: stream ${streamId} is still open on source ${cfg.sourceId}.`);
      console.error(`         Close it via the Coveo console before retrying.`);
    }
    throw err;
  }
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
