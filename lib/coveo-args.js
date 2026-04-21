'use strict';

const fs = require('fs');
const path = require('path');

const REGION_HOSTS = {
  us: 'https://api.cloud.coveo.com',
  eu: 'https://api-eu.cloud.coveo.com',
  au: 'https://api-au.cloud.coveo.com',
  ca: 'https://api-ca.cloud.coveo.com',
};

function fail(msg, usage) {
  console.error(msg);
  if (usage) {
    console.error('');
    console.error(usage);
  }
  process.exit(1);
}

function takeValue(argv, i, flag, usage) {
  const v = argv[i + 1];
  if (v == null || v.startsWith('--')) fail(`${flag} requires a value`, usage);
  return v;
}

// Shared parser for both coveo-update.js and coveo-full-rebuild.js.
// Each script passes its own USAGE string so --help prints the right banner.
function parseCoveoArgs(argv, usage) {
  const out = {
    input: null,
    orgId: null,
    sourceId: null,
    apiKey: null,
    region: 'us',
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--input':     out.input = takeValue(argv, i++, a, usage); break;
      case '--org-id':    out.orgId = takeValue(argv, i++, a, usage); break;
      case '--source-id': out.sourceId = takeValue(argv, i++, a, usage); break;
      case '--api-key':   out.apiKey = takeValue(argv, i++, a, usage); break;
      case '--region':    out.region = takeValue(argv, i++, a, usage); break;
      case '--dry-run':   out.dryRun = true; break;
      case '-h':
      case '--help':
        console.log(usage);
        process.exit(0);
      default:
        fail(`Unknown argument: ${a}`, usage);
    }
  }

  return out;
}

function resolveCoveoConfig(argv, usage) {
  const cfg = parseCoveoArgs(argv, usage);

  if (!cfg.input) fail('Missing --input', usage);
  if (!cfg.orgId) fail('Missing --org-id', usage);
  if (!cfg.sourceId) fail('Missing --source-id', usage);

  // API key: CLI flag first, else env var fallback.
  if (!cfg.apiKey) cfg.apiKey = process.env.COVEO_API_KEY || null;
  if (!cfg.apiKey) fail('Missing --api-key (or COVEO_API_KEY env var)', usage);

  const region = cfg.region.toLowerCase();
  if (!REGION_HOSTS[region]) {
    fail(`--region must be one of: ${Object.keys(REGION_HOSTS).join(', ')}`, usage);
  }
  cfg.region = region;
  cfg.baseUrl = REGION_HOSTS[region];

  cfg.input = path.resolve(process.cwd(), cfg.input);
  if (!fs.existsSync(cfg.input)) fail(`Input file not found: ${cfg.input}`, usage);

  return cfg;
}

module.exports = { resolveCoveoConfig, REGION_HOSTS };
