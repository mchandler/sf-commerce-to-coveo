'use strict';

const fs = require('fs');

function indentJson(value) {
  return JSON.stringify(value, null, 2)
    .split('\n')
    .map((line) => '    ' + line)
    .join('\n');
}

// Streams a Coveo push payload: {"addOrUpdate": [...], "delete": [...]}.
// addOrUpdate documents are written one at a time as they are built; the
// delete entries (small, known up front) are written in close().
//
// options.includeAddOrUpdate = false omits the addOrUpdate array entirely,
// producing a delete-only payload for --product-code-deletes runs.
function createStreamWriter(outputPath, { includeAddOrUpdate = true } = {}) {
  const out = fs.createWriteStream(outputPath);
  let first = true;
  let count = 0;

  out.write('{\n');
  if (includeAddOrUpdate) out.write('  "addOrUpdate": [');

  return {
    write(doc) {
      if (!includeAddOrUpdate) throw new Error('write() called on a delete-only writer');
      const body = indentJson(doc);
      out.write((first ? '\n' : ',\n') + body);
      first = false;
      count++;
    },
    close(deletes = []) {
      return new Promise((resolve, reject) => {
        if (includeAddOrUpdate) {
          if (count > 0) out.write('\n  ');
          out.write(']');
          if (deletes.length > 0) out.write(',\n');
        }
        if (deletes.length > 0 || !includeAddOrUpdate) {
          out.write('  "delete": [');
          if (deletes.length > 0) {
            out.write('\n' + deletes.map(indentJson).join(',\n') + '\n  ');
          }
          out.write(']');
        }
        out.write('\n}\n');
        out.on('finish', () => resolve(count));
        out.on('error', reject);
        out.end();
      });
    },
    get count() { return count; },
  };
}

module.exports = { createStreamWriter };
