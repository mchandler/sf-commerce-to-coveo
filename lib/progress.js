'use strict';

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function stageStart(label) {
  const start = Date.now();
  process.stderr.write(`[${label}] start\n`);
  return {
    done(details = '') {
      const elapsed = Date.now() - start;
      const suffix = details ? ` | ${details}` : '';
      process.stderr.write(`[${label}] done in ${formatDuration(elapsed)}${suffix}\n`);
    },
  };
}

function log(msg) {
  process.stderr.write(`${msg}\n`);
}

module.exports = { formatDuration, stageStart, log };
