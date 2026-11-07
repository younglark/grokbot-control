'use strict';
/**
 * Independent regressions for Exec* JSON codec + ls directory_tree_root.
 * Official inbound (daemon.formatted.cjs L136313):
 *   kd.fromJsonString(e.serverMessageJson, { ignoreUnknownFields: !0 })
 * Official ls success (daemon.formatted.cjs ~L129463 / proto LsSuccess):
 *   directory_tree_root: LsDirectoryTreeNode { abs_path, children_dirs, children_files, ... }
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  GrokBotUserComputerQueuedRequest,
} = require('../dist/generated/aiserver.v1_pb');
const { parseQueued } = require('../dist/uc/provider');
const {
  decodeExecServerMessageJson,
  encodeExecClientControlMessageJson,
  encodeExecClientMessageJson,
  encodeExecClientMessage,
  execServerMessageToRecord,
  isInterimLsListingMessage,
  prepareBoxExecFrame,
} = require('../dist/exec/exec-codec');
const { handleLs, resetExecIdCounter } = require('../dist/exec/handlers');
const wire = require('./helpers/wire-oracle.cjs');

function queuedExec(requestId, serverMessageJson) {
  const frame = Buffer.concat([
    wire.encStr(1, requestId),
    wire.encMsg(2, wire.encStr(1, serverMessageJson)),
  ]);
  return GrokBotUserComputerQueuedRequest.fromBinary(Buffer.concat([
    wire.encStr(1, 'q-'+requestId),
    wire.encMsg(2, frame),
  ]));
}

test('decodeExecServerMessageJson accepts official ignoreUnknownFields and legal readArgs', () => {
  const msg = decodeExecServerMessageJson(JSON.stringify({
    id: 7,
    futureUnknown: true,
    readArgs: { path: 'probe.txt', toolCallId: 't' },
  }));
  const rec = execServerMessageToRecord(msg);
  assert.equal(rec.id, 7);
  assert.equal(rec.readArgs.path, 'probe.txt');
  assert.equal(rec.futureUnknown, undefined);
});

test('decodeExecServerMessageJson rejects bad JSON with official cannot-decode prefix', () => {
  assert.throws(
    () => decodeExecServerMessageJson('{'),
    (e) => /cannot decode agent\.v1\.ExecServerMessage from JSON:/.test(e.message),
  );
});

test('decodeExecServerMessageJson rejects wrong field types', () => {
  assert.throws(
    () => decodeExecServerMessageJson(JSON.stringify({ id: 'not-a-uint32', readArgs: { path: 'p', toolCallId: 't' } })),
    (e) => /cannot decode field agent\.v1\.ExecServerMessage\.id/.test(e.message),
  );
});

test('parseQueued maps decode failures to parseError without inventing prefixes', () => {
  const bad = queuedExec('bad-json', '{');
  const q = parseQueued(bad);
  assert.match(q.parseError || '', /cannot decode agent\.v1\.ExecServerMessage from JSON:/);
  assert.equal(q.kind, 0);

  const ok = queuedExec('ok-read', JSON.stringify({ id: 3, readArgs: { path: 'a', toolCallId: 't' } }));
  const q2 = parseQueued(ok);
  assert.equal(q2.parseError, undefined);
  assert.equal(q2.serverMessage.id, 3);
  assert.equal(q2.serverMessage.readArgs.path, 'a');
});

test('outbound control throw/streamClose round-trip via generated ExecClientControlMessage', () => {
  assert.equal(
    encodeExecClientControlMessageJson({ throw: { id: 1, error: 'No handler found for server message of type writeShellStdinArgs' } }),
    JSON.stringify({ throw: { id: 1, error: 'No handler found for server message of type writeShellStdinArgs' } }),
  );
  assert.equal(
    encodeExecClientControlMessageJson({ streamClose: { id: 1 } }),
    JSON.stringify({ streamClose: { id: 1 } }),
  );
});

test('outbound client {id:7} golden-stable; schema ls encodes; interim/typo throw', () => {
  assert.equal(encodeExecClientMessageJson({ id: 7 }), JSON.stringify({ id: 7 }));

  const schemaLs = {
    id: 1,
    lsResult: {
      success: {
        directoryTreeRoot: {
          absPath: '/tmp/demo',
          childrenFiles: [{ name: 'a.txt' }],
          childrenWereProcessed: true,
        },
      },
    },
  };
  assert.equal(isInterimLsListingMessage(schemaLs), false);
  const encoded = encodeExecClientMessage(schemaLs);
  assert.equal(encoded.lsResult.success.directoryTreeRoot.absPath, '/tmp/demo');
  assert.equal(encoded.lsResult.success.directoryTreeRoot.childrenFiles[0].name, 'a.txt');
  assert.equal(encoded.lsResult.success.path, undefined);
  assert.equal(encoded.lsResult.success.entries, undefined);

  const interim = { id: 1, lsResult: { success: { path: '/tmp', entries: [{ name: 'a', type: 'file' }] } } };
  assert.equal(isInterimLsListingMessage(interim), true);
  assert.throws(() => encodeExecClientMessage(interim), (e) => /unknown|cannot decode/i.test(e.message));

  const typoExtra = {
    id: 1,
    readResult: { success: { path: '/a', content: 'hi', totalLines: 1, fileSize: '2' } },
    typoExtra: true,
  };
  assert.throws(() => encodeExecClientMessage(typoExtra), (e) => /unknown|cannot decode/i.test(e.message));
  assert.throws(() => encodeExecClientMessageJson(typoExtra), (e) => /unknown|cannot decode/i.test(e.message));
});

test('handleLs matches official 0.79.3 oracle: LsResult.error ripgrep-unconfigured (not a tree)', async () => {
  const oracle = require('./fixtures/official-0793-oracle-r3.json').cases.ls;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'led-ls-'));
  try {
    const got = [];
    await handleLs({ root, requestId: 'ls1', msgId: 1, path: root, emit: (f) => got.push(f) });
    const real = fs.realpathSync(root);
    const norm = got.map((f) => {
      const m = JSON.parse(JSON.stringify(f.message).split(real).join('<ROOT>'));
      delete m.localExecutionTimeMs;
      return { kind: f.kind, message: m };
    });
    const want = oracle.map((f) => ({ kind: f.kind, message: f.message }));
    assert.deepEqual(norm, want);
    // Generated codec accepts it (no hand-written wire shape).
    const box = prepareBoxExecFrame(got.find((f) => f.kind === 'client'));
    assert.equal(box.message.lsResult.error.error, oracle[0].message.lsResult.error.error);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prepareBoxExecFrame runs client/control through the same Exec* codec', () => {
  const client = prepareBoxExecFrame({
    kind: 'client',
    requestId: 'box-read',
    message: { id: 1, readResult: { success: { path: '/a', content: 'hi', totalLines: 1, fileSize: '2' } } },
  });
  assert.equal(client.kind, 'client');
  assert.equal(client.requestId, 'box-read');
  assert.equal(client.message.id, 1);
  assert.equal(client.message.readResult.success.path, '/a');
  assert.equal(client.message.typoExtra, undefined);

  const control = prepareBoxExecFrame({
    kind: 'control',
    requestId: 'box-close',
    message: { streamClose: { id: 2 } },
    cwdState: 'unset',
  });
  assert.equal(control.kind, 'control');
  assert.deepEqual(control.message, { streamClose: { id: 2 } });
  assert.equal(control.cwdState, 'unset');

  assert.throws(
    () => prepareBoxExecFrame({
      kind: 'client',
      requestId: 'bad',
      message: {
        id: 1,
        readResult: { success: { path: '/a', content: 'x', totalLines: 1, fileSize: '1' } },
        typoExtra: 1,
      },
    }),
    (e) => /unknown|cannot decode/i.test(e.message),
  );

  const fileErr = prepareBoxExecFrame({ kind: 'file-error', requestId: 'dl', error: 'nope' });
  assert.deepEqual(fileErr, { kind: 'file-error', requestId: 'dl', error: 'nope' });
});
