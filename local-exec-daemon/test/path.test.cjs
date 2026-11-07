'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Use compiled JS
const { assertUnderRoot, assertRealpathUnderRoot, PathGuardError } = require('../dist/exec/path.js');

describe('path guard', () => {
  it('refuses lexical escape', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-'));
    assert.throws(() => assertUnderRoot(root, '/etc/passwd'), PathGuardError);
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('refuses symlink escape', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-'));
    fs.symlinkSync('/tmp', path.join(root, 'x'));
    assert.throws(() => assertRealpathUnderRoot(root, path.join(root, 'x', 'foo')), /symlink/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
