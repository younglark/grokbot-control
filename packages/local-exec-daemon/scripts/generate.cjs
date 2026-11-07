'use strict';
// Compatibility entry point; the canonical generator lives in the protocol workspace.
process.argv.push('--target=daemon');
require('../../protocol/scripts/generate.cjs');
