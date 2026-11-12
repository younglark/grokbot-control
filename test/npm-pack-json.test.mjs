import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastJsonValue } from '../scripts/npm-pack-json.mjs';

const pack = [
  {
    id: 'grokbot-control@0.4.1',
    name: 'grokbot-control',
    version: '0.4.1',
    filename: 'grokbot-control-0.4.1.tgz',
    files: [
      { path: 'package.json', size: 12, mode: 420 },
      { path: 'dist/cli/main.js', size: 34, mode: 420 },
    ],
    bundled: [],
  },
];

const pretty = `${JSON.stringify(pack, null, 2)}\n`;
const compact = `${JSON.stringify(pack)}\n`;
// Same leading ANSI/vite noise that broke release-github.mjs JSON.parse
// on the v0.4.1 mint: Unexpected token '\u001b', "\u001b[36mvite "...
const viteLogs =
  '\u001b[36mvite\u001b[39m v8.3.8 building client environment for production...\n' +
  'transforming...\n' +
  '\u001b[32m✓\u001b[39m 2244 modules transformed.\n' +
  'rendering chunks...\n';

test('lastJsonValue parses a clean npm pack --json array', () => {
  assert.deepEqual(lastJsonValue(pretty), pack);
  assert.deepEqual(lastJsonValue(compact), pack);
  assert.deepEqual(lastJsonValue(`\n${pretty}`), pack);
});

test('lastJsonValue parses pack JSON after ANSI vite prepack logs', () => {
  const prettyPrefixed = `${viteLogs}${pretty}`;
  const compactPrefixed = `${viteLogs}${compact}`;
  assert.throws(() => JSON.parse(prettyPrefixed), /Unexpected token/);
  assert.throws(() => JSON.parse(compactPrefixed), /Unexpected token/);
  assert.deepEqual(lastJsonValue(prettyPrefixed), pack);
  assert.deepEqual(lastJsonValue(compactPrefixed), pack);
  assert.equal(lastJsonValue(prettyPrefixed)[0].filename, 'grokbot-control-0.4.1.tgz');
  assert.equal(lastJsonValue(prettyPrefixed)[0].files[0].path, 'package.json');
});

test('lastJsonValue rejects stdout that has no trailing JSON array', () => {
  assert.throws(() => lastJsonValue(`${viteLogs}not json\n`), /unable to locate trailing npm pack JSON array|not valid JSON/);
  assert.throws(() => lastJsonValue(''), SyntaxError);
});
