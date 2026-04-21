'use strict';

const fs = require('fs');

function createStreamWriter(outputPath) {
  const out = fs.createWriteStream(outputPath);
  let first = true;
  let count = 0;

  out.write('{\n  "addOrUpdate": [');

  return {
    write(doc) {
      const body = JSON.stringify(doc, null, 2)
        .split('\n')
        .map((line) => '    ' + line)
        .join('\n');
      if (first) {
        out.write('\n' + body);
        first = false;
      } else {
        out.write(',\n' + body);
      }
      count++;
    },
    close() {
      return new Promise((resolve, reject) => {
        if (count > 0) out.write('\n  ');
        out.write(']\n}\n');
        out.on('finish', () => resolve(count));
        out.on('error', reject);
        out.end();
      });
    },
    get count() { return count; },
  };
}

module.exports = { createStreamWriter };
