'use strict';

const fs = require('fs');
const path = require('path');

const COLUMNS = ['ProductId', 'ProductCode', 'StockKeepingUnit', 'Name', 'ProductClass', 'ParentId'];

function csvField(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// Writes a sidecar CSV next to the JSON output with one row per entitled
// product that lacked a PricebookEntry. Path: <output-basename>-unpriced.csv
// in the same directory as the main --output. Auto-deletes if nothing is
// logged (so a clean run leaves no trailing empty file).
function createUnpricedLog(outputPath) {
  const dir = path.dirname(outputPath);
  const base = path.basename(outputPath, path.extname(outputPath));
  const file = path.join(dir, `${base}-unpriced.csv`);
  const out = fs.createWriteStream(file);
  let count = 0;

  out.write(COLUMNS.join(',') + '\n');

  return {
    file,
    log(entry) {
      count++;
      const row = COLUMNS.map((c) => csvField(entry[c])).join(',');
      out.write(row + '\n');
    },
    get count() { return count; },
    close() {
      return new Promise((resolve, reject) => {
        out.on('finish', () => {
          if (count === 0) {
            try { fs.unlinkSync(file); } catch (_) { /* ignore */ }
          }
          resolve(count);
        });
        out.on('error', reject);
        out.end();
      });
    },
  };
}

module.exports = { createUnpricedLog };
