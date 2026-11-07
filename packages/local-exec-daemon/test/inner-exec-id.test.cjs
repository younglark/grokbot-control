'use strict';
/**
 * Independent regression: UC inner message id reallocation.
 * Evidence: official daemon.formatted.cjs ~L135935 nextExecId=1; ~L136346-136347
 *   let a = this.nextExecId++; o.id = a;
 * Compat must NOT echo server inner id (e.g. 7 → reply still 7).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  dispatchExec,
  resetExecIdCounter,
  shutdownShells,
} = require('../dist/exec/handlers');
const { ExecServerMessage, ExecClientMessage } = require('../dist/generated/agent.v1_pb');
const ai = require('../dist/generated/aiserver.v1_2_pb');
const aiMain = require('../dist/generated/aiserver.v1_pb');

test('generated ExecServerMessage/ExecClientMessage exist with official field numbers', () => {
  const serverFields = Object.fromEntries(ExecServerMessage.fields.list().map(f => [f.name, f.no]));
  assert.equal(serverFields.id, 1);
  assert.equal(serverFields.exec_id, 15);
  assert.equal(serverFields.shell_args, 2);
  assert.equal(serverFields.read_args, 7);
  assert.equal(serverFields.shell_stream_args, 14);
  const clientFields = Object.fromEntries(ExecClientMessage.fields.list().map(f => [f.name, f.no]));
  assert.equal(clientFields.id, 1);
  assert.equal(clientFields.exec_id, 15);
  assert.equal(clientFields.shell_result, 2);
  assert.equal(clientFields.shell_stream, 14);
});


test('top-level FileDiff shape matches parent/daemon, not EditFileResult.FileDiff', () => {
  const top = Object.fromEntries(ai.FileDiff.fields.list().map(f => [f.name, f.no]));
  assert.equal(top.from, 1);
  assert.equal(top.to, 2);
  assert.equal(top.chunks, 3);
  assert.equal(top.added, 4);
  assert.equal(top.removed, 5);
  assert.equal(top.before_file_contents, 6);
  assert.equal(top.after_file_contents, 7);
  // Nested Chunk under top-level FileDiff
  const chunk = Object.fromEntries(ai.FileDiff_Chunk.fields.list().map(f => [f.name, f.no]));
  assert.equal(chunk.content, 1);
  assert.equal(chunk.lines, 2);
  assert.equal(chunk.old_start, 3);
  assert.equal(chunk.old_lines, 4);
  assert.equal(chunk.new_start, 5);
  assert.equal(chunk.new_lines, 6);
  // Nested EditFileResult.FileDiff must remain the other shape
  const nested = Object.fromEntries(aiMain.EditFileResult_FileDiff.fields.list().map(f => [f.name, f.no]));
  assert.equal(nested.chunks, 1);
  assert.equal(nested.editor, 2);
  assert.equal(nested.hit_timeout, 3);
  assert.notEqual(top.chunks, nested.chunks, 'top-level chunks field number must differ from EditFileResult.FileDiff');
  assert.ok(!('from' in nested));
  assert.ok(!('editor' in top));
});

test('server inner id≠1 reallocates reply id to sequential local ids starting at 1', async () => {
  resetExecIdCounter(1);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-exec-id-'));
  fs.writeFileSync(path.join(root, 'probe.txt'), 'ok');
  const got = [];
  const emit = (f) => { got.push(f); };
  try {
    await dispatchExec({
      root,
      requestId: 'r1',
      serverMessage: { id: 7, execId: 'wire', readArgs: { path: 'probe.txt' } },
      permission: 'always',
      emit,
    });
    const r1 = got.filter((f) => f.requestId === 'r1');
    assert.ok(r1.length >= 2, 'expect client + streamClose');
    for (const f of r1) {
      const id = f.message?.id ?? f.message?.throw?.id ?? f.message?.streamClose?.id;
      assert.equal(id, 1, `first exec reply inner id must be 1, got ${JSON.stringify(f.message)}`);
    }
    assert.notEqual(7, 1);

    got.length = 0;
    await dispatchExec({
      root,
      requestId: 'r2',
      serverMessage: { id: 99, execId: 'wire', readArgs: { path: 'probe.txt' } },
      permission: 'always',
      emit,
    });
    const r2 = got.filter((f) => f.requestId === 'r2');
    for (const f of r2) {
      const id = f.message?.id ?? f.message?.throw?.id ?? f.message?.streamClose?.id;
      assert.equal(id, 2, `second exec reply inner id must be 2, got ${JSON.stringify(f.message)}`);
    }
  } finally {
    await shutdownShells();
    fs.rmSync(root, { recursive: true, force: true });
    resetExecIdCounter(1);
  }
});

test('outer requestId cancel remains keyed by requestId, not server inner id', async () => {
  resetExecIdCounter(1);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-exec-cancel-'));
  const { handleShellStream, cancelRequest } = require('../dist/exec/handlers');
  const got = [];
  try {
    const job = handleShellStream({
      root,
      requestId: 'cancel-me',
      msgId: 1,
      command: 'sleep 30',
      emit: (f) => got.push(f),
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(cancelRequest('cancel-me'), true);
    await job;
    const exit = got.find((f) => f.message?.shellStream?.exit);
    assert.equal(exit?.message?.shellStream?.exit?.aborted, true);
    assert.equal(exit?.message?.id, 1);
  } finally {
    await shutdownShells();
    fs.rmSync(root, { recursive: true, force: true });
    resetExecIdCounter(1);
  }
});
