'use strict';

const { execFile } = require('child_process');

function runSf(args) {
  return new Promise((resolve, reject) => {
    // shell: true on Windows lets the shell resolve `sf` → `sf.cmd`. Without
    // it, Node's execFile can't find the CLI entry point and fails with
    // ENOENT. Args here are all internal constants plus the --sf-org value,
    // which lib/args.js validates against a strict alias pattern — so no
    // shell-injection surface is opened by this change.
    execFile('sf', args, {
      maxBuffer: 5 * 1024 * 1024,
      shell: process.platform === 'win32',
    }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr && stderr.trim() ? stderr.trim() : err.message;
        return reject(new Error(`sf ${args.join(' ')} failed: ${msg}`));
      }
      resolve(stdout);
    });
  });
}

function parseSfJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (e) {
    throw new Error(`Could not parse ${label} output: ${e.message}`);
  }
}

// A real SF access token is a single opaque string with no whitespace. Newer
// CLI versions REDACT it in `sf org display --json`, returning the literal
// "[REDACTED] Use 'sf org auth show-access-token' to view" — which contains
// spaces and the word REDACTED. Anything matching those is not a usable token.
function looksLikeRealToken(value) {
  return typeof value === 'string'
    && value.length > 0
    && !/\s/.test(value)
    && !/REDACTED/i.test(value);
}

async function fetchSession(orgAlias) {
  // `sf org display --json` gives us instanceUrl + username (never redacted)
  // and, on OLDER CLI versions, the real accessToken too. On NEWER versions
  // the token comes back redacted, so we fall back to
  // `sf org auth show-access-token` — which older CLIs don't have. Trying
  // display first and only falling back when the token is redacted keeps this
  // working across CLI versions (the fallback subcommand is never invoked on
  // CLIs that lack it).
  const displayOut = await runSf(['org', 'display', '--target-org', orgAlias, '--json']);
  const display = parseSfJson(displayOut, 'sf org display');
  const dResult = display && display.result;
  if (!dResult || !dResult.instanceUrl) {
    throw new Error(`sf org display did not return instanceUrl for org "${orgAlias}"`);
  }

  let accessToken = dResult.accessToken;
  if (!looksLikeRealToken(accessToken)) {
    // Token was redacted (newer CLI). Pull the real one from the dedicated
    // subcommand. --no-prompt skips its interactive security confirmation.
    const tokenOut = await runSf([
      'org', 'auth', 'show-access-token', '--target-org', orgAlias, '--no-prompt', '--json',
    ]);
    const token = parseSfJson(tokenOut, 'sf org auth show-access-token');
    accessToken = token && token.result && token.result.accessToken;
  }

  if (!looksLikeRealToken(accessToken)) {
    throw new Error(`Could not obtain a usable access token for org "${orgAlias}"`);
  }

  return {
    accessToken,
    instanceUrl: dResult.instanceUrl.replace(/\/$/, ''),
    username: dResult.username || null,
  };
}

function createSession(orgAlias) {
  let cached = null;
  return {
    orgAlias,
    async get() {
      if (!cached) cached = await fetchSession(orgAlias);
      return cached;
    },
    async refresh() {
      cached = await fetchSession(orgAlias);
      return cached;
    },
  };
}

module.exports = { createSession };
