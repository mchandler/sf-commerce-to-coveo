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

async function fetchSession(orgAlias) {
  const stdout = await runSf(['org', 'display', '--target-org', orgAlias, '--json']);
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (e) {
    throw new Error(`Could not parse sf org display output: ${e.message}`);
  }
  const result = parsed && parsed.result;
  if (!result || !result.accessToken || !result.instanceUrl) {
    throw new Error(`sf org display did not return accessToken/instanceUrl for org "${orgAlias}"`);
  }
  return {
    accessToken: result.accessToken,
    instanceUrl: result.instanceUrl.replace(/\/$/, ''),
    username: result.username || null,
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
