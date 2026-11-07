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

test('handleLs success emits directoryTreeRoot that encodes without interim fallback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'led-ls-'));
  try {
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    fs.writeFileSync(path.join(root, 'b.txt'), 'y');
    resetExecIdCounter(1);
    const got = [];
    await handleLs({ root, requestId: 'ls1', msgId: 1, path: root, emit: (f) => got.push(f) });
    const client = got.find((f) => f.kind === 'client');
    assert.ok(client);
    const tree = client.message.lsResult.success.directoryTreeRoot;
    assert.equal(tree.absPath, fs.realpathSync(root));
    assert.equal(tree.childrenWereProcessed, true);
    assert.deepEqual(
      (tree.childrenFiles || []).map((f) => f.name).sort(),
      ['a.txt', 'b.txt'],
    );
    assert.equal((tree.childrenDirs || []).length, 1);
    assert.equal(path.basename(tree.childrenDirs[0].absPath), 'sub');
    assert.equal(client.message.lsResult.success.entries, undefined);
    assert.equal(client.message.lsResult.success.path, undefined);
    // Production path: encode without interim detector
    const round = encodeExecClientMessage(client.message);
    assert.equal(round.lsResult.success.directoryTreeRoot.absPath, tree.absPath);
    assert.equal(isInterimLsListingMessage(client.message), false);
    const box = prepareBoxExecFrame(client);
    assert.equal(box.message.lsResult.success.directoryTreeRoot.absPath, tree.absPath);
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
