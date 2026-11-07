'use strict';
/**
 * Independent regressions for Exec* JSON codec.
 * Official inbound: kd.fromJsonString(json, { ignoreUnknownFields: true }) (daemon ~L136327).
 * Outbound client/control: *.toJson() into messageJson string.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  GrokBotUserComputerQueuedRequest,
} = require('../dist/generated/aiserver.v1_pb');
const { parseQueued } = require('../dist/uc/provider');
const {
  decodeExecServerMessageJson,
  encodeExecClientControlMessageJson,
  encodeExecClientMessageJson,
  execServerMessageToRecord,
} = require('../dist/exec/exec-codec');
const wire = require('./helpers/wire-oracle.cjs');

function queuedExec(requestId, serverMessageJson) {
  // Matches uc-fake-peer buildExecFrame / buildQueued.
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

test('outbound client {id:7} golden-stable; schema-invalid ls falls back without throwing', () => {
  assert.equal(encodeExecClientMessageJson({ id: 7 }), JSON.stringify({ id: 7 }));
  const fakeLs = { id: 1, lsResult: { success: { path: '/tmp', entries: [{ name: 'a', type: 'file' }] } } };
  assert.equal(encodeExecClientMessageJson(fakeLs), JSON.stringify(fakeLs));
});
