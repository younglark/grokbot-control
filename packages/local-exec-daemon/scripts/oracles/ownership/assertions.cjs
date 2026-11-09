"use strict";
const assert = require('node:assert/strict');
const OFFICIAL_SHA256 = '5c1424ed3784704abbb20e83ced15ab8ebd161ddef5e7f1a74eed374453d36be';
const OFFICIAL_LOG = '[sand-local-exec-daemon] superseded by the daemon the discovery record names, shutting down';
function assertSupersededExit(output, exit, mode) {
  assert.equal(exit.code, 0); assert.equal(exit.signal, null);
  assert.ok(mode === 'official' || mode === 'implementation');
  // t171: the implementation now prints the original l$t text (D:79742–79747), so both modes expect OFFICIAL_LOG.
  assert.ok(output.split(/\r?\n/).includes(OFFICIAL_LOG), 'missing exact superseded shutdown log');
}
module.exports = { OFFICIAL_SHA256, OFFICIAL_LOG, assertSupersededExit };
