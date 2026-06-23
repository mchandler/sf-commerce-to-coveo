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

async function fetchSession(orgAlias) {
  // Two calls on purpose: recent SF CLI versions (>= ~2.x) REDACT the
  // accessToken in `sf org display --json`, returning the literal string
  // "[REDACTED] Use 'sf org auth show-access-token' to view" instead of the
  // token. That placeholder produces an INVALID_AUTH_HEADER / 401 when used
  // as a Bearer token. instanceUrl and username are NOT redacted, so we still
  // source those from `org display` and pull the real token from
  // `org auth show-access-token --no-prompt`.
  const displayOut = await runSf(['org', 'display', '--target-org', orgAlias, '--json']);
  const display = parseSfJson(displayOut, 'sf org display');
  const dResult = display && display.result;
  if (!dResult || !dResult.instanceUrl) {
    throw new Error(`sf org display did not return instanceUrl for org "${orgAlias}"`);
  }

  const tokenOut = await runSf([
    'org', 'auth', 'show-access-token', '--target-org', orgAlias, '--no-prompt', '--json',
  ]);
  const token = parseSfJson(tokenOut, 'sf org auth show-access-token');
  const accessToken = token && token.result && token.result.accessToken;
  if (!accessToken) {
    throw new Error(`sf org auth show-access-token did not return an accessToken for org "${orgAlias}"`);
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
