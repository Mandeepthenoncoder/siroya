'use strict';
/* Makes `node --test server/test/` work on Node 22: a directory argument is
   run as a module (this file) rather than searched. Loads every *.test.js
   here. When the runner discovers files itself (`node --test` with no
   arguments, or a glob), this file is run directly and does nothing, so no
   test runs twice. A file that fails to load is reported as one failing
   test and the other files still run. */
const fs = require('node:fs');
const path = require('node:path');

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry !== __filename) {
  for (const name of fs.readdirSync(__dirname).sort()) {
    if (!/\.test\.c?js$/.test(name)) continue;
    try {
      require(path.join(__dirname, name));
    } catch (err) {
      require('node:test').test(`${name} could not be loaded`, () => { throw err; });
    }
  }
}
