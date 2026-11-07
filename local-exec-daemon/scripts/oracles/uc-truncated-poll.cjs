'use strict';
// Run the existing independent oracle harness in the corrupt-wire mode.
process.argv.push('--truncated-poll');
require('./uc-bad-frames.cjs');
