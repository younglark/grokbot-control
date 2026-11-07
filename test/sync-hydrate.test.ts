import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SyncOps, entryRecord } from "../src/sync/core.js";
import { Archive, component } from "../src/sync/fs.js";
import { decodeStored, BODY_DECODE_MAX } from "../src/sync/decode.js";
import { hydrateEntries } from "../src/sync/hydrate.js";
import { buildTools } from "../src/mcp/tools.js";
import { GrokBotTranscriptEntry } from "../vendor/proto-gen/aiserver.v1_pb.js";
const bytes = (text = "正文补全测试 中文 HYDRATED_BODY_OK") =>
  Buffer.from(
    JSON.stringify({
      id: "ui-1",
      kind: "message",
      content: text,
      role: "assistant",
    }),
  );
const row = (seq = 9n, extra: any = {}) =>
  new GrokBotTranscriptEntry({
    seq,
    updatedSeq: seq,
    entryKind: "message",
    bodyOmitted: true,
    ...extra,
  });
const gd = `bots/${component("a")}/sessions/${component("s")}/generations/1`;
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-body-"));
  let calls: any[] = [],
    fetches: any[] = [];
  let head: any = { generation: 1, entries: [row()] },
    exact: any = {
      generation: 1,
      entries: [row(9n, { body: bytes(), bodyOmitted: false })],
    };
  let presign: (req: any) => any = (req) => ({
    instructions: req.relPaths.map((relPath: string) => ({
      relPath,
      url: "https://body.example/store?signature=BODY_URL_DO_NOT_LOG",
      expiresAtMs: BigInt(Date.now() + 120000),
    })),
  });
  let fetcher: any = async () => new Response(bytes());
  const client = {
    async listGrokBotAgents() {
      calls.push(["bots", {}]);
      return { agents: [{ id: "a" }] };
    },
    async listGrokBotAgentSessions() {
      calls.push(["sessions", {}]);
      return { sessions: [{ sessionId: "s", agentId: "a" }] };
    },
    async listGrokBotTranscriptEntries(req: any) {
      calls.push(["list", req]);
      return req.limit === 1
        ? exact
        : req.beforeSeq === undefined
          ? head
          : { generation: head.generation, entries: [] };
    },
    async presignSandBoxStoreReads(req: any) {
      calls.push(["presign", req]);
      return presign(req);
    },
  };
  const ops = new SyncOps(client, "https://api.example", true, (u, o) => {
    fetches.push([u, o]);
    return fetcher(u, o);
  });
  const input = {
    dir,
    agentId: "a",
    sessionId: "s",
    accountId: "u",
    teamId: "none",
    acknowledgeUnverifiedScope: true,
    maxPages: 1,
    hydrate: "missing" as const,
  };
  return {
    dir,
    calls,
    fetches,
    client,
    ops,
    input,
    setHead(v: any) {
      head = v;
    },
    setExact(v: any) {
      exact = v;
    },
    setPresign(v: any) {
      presign = v;
    },
    setFetch(v: any) {
      fetcher = v;
    },
    entries() {
      return new Archive(dir)
        .read(`${gd}/entries.jsonl`)!
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((x) => JSON.parse(x));
    },
    state() {
      return new Archive(dir).json(`${gd}/state.json`);
    },
  };
}
it("omitted hydration binds exact session/generation/seq/version, preserves original wire and grep/render Chinese", async () => {
  const f = fixture(),
    original = row();
  const result = await f.ops.pull(f.input);
  assert.equal(result.ok, true, JSON.stringify(result));
  const e = f.entries()[0];
  assert.equal(e.body_omitted, true);
  assert.equal(e.body_base64, undefined);
  assert.deepEqual(e.raw, original.toJson());
  assert.equal(
    e.wire_base64,
    Buffer.from(original.toBinary()).toString("base64"),
  );
  assert.equal(e.hydration.source, "omitted_list");
  assert.equal(e.hydration.status, "fetched");
  assert.equal(e.hydration.body_base64, undefined);
  assert.ok(e.hydration.object_rel);
  assert.equal(e.decoded.text, "正文补全测试 中文 HYDRATED_BODY_OK");
  const readObject = (rel: string) =>
    fs.readFileSync(new Archive(f.dir).file(rel));
  assert.equal(decodeStored(e, readObject).body_source, "hydrated_omitted");
  const reread = f.calls.find((x) => x[0] === "list" && x[1].limit === 1)[1];
  assert.deepEqual(reread, {
    agentId: "a",
    sessionId: "s",
    generation: 1,
    beforeSeq: 10n,
    limit: 1,
  });
  assert.equal(f.state().body_coverage.hydrated_version_bound, 1);
  assert.equal(f.state().body_coverage.observed_inline, 0);
  assert.equal(f.state().completeness, "unknown");
  const n = f.calls.length;
  assert.equal((await f.ops.render({ dir: f.dir })).ok, true);
  const st: any = await f.ops.status({ dir: f.dir });
  assert.equal(st.data.sessions[0].body_coverage.decoded, 1);
  assert.equal(f.calls.length, n);
  for (const file of [
    new Archive(f.dir).file(`${gd}/entries.jsonl`),
    new Archive(f.dir).file(
      `derived/${component("a")}/${component("s")}/transcript.md`,
    ),
  ])
    assert.equal(spawnSync("rg", ["-q", "正文补全测试 中文", file]).status, 0);
  assert.equal(
    fs.statSync(new Archive(f.dir).file(e.hydration.object_rel)).mode & 0o777,
    0o600,
  );
});
it("hydration defaults off; pure CLI/shared dry-run makes no RPC and creates no archive", async () => {
  const f = fixture(),
    target = path.join(f.dir, "not-created");
  const dry = await f.ops.pull({ ...f.input, dir: target, dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(target), false);
  const cli = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/cli/main.ts",
      "--dry-run",
      "sync",
      "pull",
      "--dir",
      target,
      "--agent-id",
      "a",
      "--account-id",
      "u",
      "--team-id",
      "none",
      "--ack-unverified-scope",
      "--hydrate",
      "missing",
      "--max-hydrate-requests",
      "2",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GBT_CREDENTIALS_DIR: path.join(target, "no-auth"),
      },
      encoding: "utf8",
    },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(fs.existsSync(target), false);
  const off = await f.ops.pull({ ...f.input, hydrate: undefined });
  assert.equal(off.ok, true);
  assert.equal(f.calls.filter((x) => x[0] === "list").length, 1);
  assert.equal(f.entries()[0].hydration, undefined);
});
for (const [name, change] of [
  ["wrong seq", { entries: [row(8n, { body: bytes() })] }],
  [
    "wrong kind",
    { entries: [row(9n, { entryKind: "notice", body: bytes() })] },
  ],
  ["missing exact row", { entries: [] }],
  ["ambiguous exact rows", { entries: [row(), row()] }],
  [
    "unsafe numeric uint64",
    {
      entries: [{ seq: 9, updatedSeq: 9, entryKind: "message", body: bytes() }],
    },
  ],
] as const)
  it(`exact omitted read rejects ${name} without stopping archive`, async () => {
    const f = fixture();
    f.setExact({ generation: 1, ...change });
    const r = await f.ops.pull(f.input);
    assert.equal(r.ok, false);
    assert.equal(r.code, "partial");
    assert.equal((r.data as any).partial, true);
    const e = f.entries()[0];
    assert.equal(e.hydration.status, "error");
    assert.equal(e.decoded, undefined);
    assert.equal(e.body_omitted, true);
    assert.equal(e.hydration.retry, "never");
  });
it("exact omitted read with larger updated_seq merges then hydrates the new version", async () => {
  const f = fixture();
  f.setExact({
    generation: 1,
    entries: [row(9n, { updatedSeq: 10n, body: bytes("合并后正文") })],
  });
  const r = await f.ops.pull(f.input);
  assert.equal(r.ok, true, JSON.stringify(r));
  const e = f.entries()[0];
  assert.equal(e.updated_seq, "10");
  assert.equal(e.body_base64 !== undefined, true);
  assert.equal(e.decoded.text, "合并后正文");
  assert.equal(e.hydration, undefined); // adopted as observation, not hydration fiction
  assert.equal((r.data as any).sessions[0].hydration.version_adopted, 1);
});
it("generation change invalidates current session and does not publish mixed bodies", async () => {
  const f = fixture();
  assert.equal((await f.ops.pull({ ...f.input, hydrate: "off" })).ok, true);
  const prior = f.entries();
  f.setExact({ generation: 2, entries: [row(9n, { body: bytes() })] });
  const r = await f.ops.pull(f.input);
  assert.equal(r.ok, false);
  assert.deepEqual(f.entries(), prior);
  const a = new Archive(f.dir);
  assert.equal(
    a.json(`bots/${component("a")}/sessions/${component("s")}/session.json`)
      .current_generation,
    null,
  );
  assert.equal((await f.ops.status({ dir: f.dir })).ok, true);
  assert.equal((await f.ops.render({ dir: f.dir })).ok, false);
});
it("UINT64_MAX omitted successor is rejected without issuing an overflowing read", async () => {
  const f = fixture();
  f.setHead({ generation: 1, entries: [row(18446744073709551615n)] });
  const r = await f.ops.pull(f.input);
  assert.equal(r.code, "partial");
  assert.equal(f.calls.filter((x) => x[0] === "list").length, 1);
  assert.equal(f.entries()[0].hydration.reason, "seq_successor_overflow");
});
it("body inline wins over omitted flag and blob ref with no presign", async () => {
  const f = fixture();
  f.setHead({
    generation: 1,
    entries: [
      row(9n, {
        body: bytes("原始 inline"),
        blobHash: "opaque-token",
        bodyOmitted: true,
      }),
    ],
  });
  assert.equal((await f.ops.pull(f.input)).ok, true);
  const e = f.entries()[0];
  assert.equal(e.decoded.text, "原始 inline");
  assert.equal(e.hydration, undefined);
  assert.equal(f.calls.length, 3);
  assert.equal(decodeStored(e).body_source, "observed_inline");
});
it("blob ref dedup is batch scoped, hash opaque, objects locally SHA256, URLs/auth never persisted", async () => {
  const f = fixture();
  f.setHead({
    generation: 1,
    entries: [
      row(9n, { bodyOmitted: false, blobHash: "opaque-not-a-digest" }),
      row(8n, { blobHash: "opaque-not-a-digest" }),
    ],
  });
  const r = await f.ops.pull(f.input);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(f.fetches.length, 1);
  assert.equal(f.calls.filter((x) => x[0] === "presign").length, 1);
  assert.deepEqual(f.calls.find((x) => x[0] === "presign")[1], {
    relPaths: ["blobs/opaque-not-a-digest"],
  });
  assert.equal(f.calls.filter((x) => x[0] === "list").length, 1);
  for (const e of f.entries()) {
    assert.equal(e.hydration.source, "blob");
    assert.equal(e.attachment_local, undefined);
    assert.equal(e.hydration.remote_blob_ref, "opaque-not-a-digest");
    assert.match(e.hydration.content_sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(JSON.stringify(r).includes("BODY_URL_DO_NOT_LOG"), false);
  assert.equal(
    new Archive(f.dir)
      .read(`${gd}/entries.jsonl`)!
      .includes("BODY_URL_DO_NOT_LOG"),
    false,
  );
  assert.deepEqual(f.fetches[0][1].headers, {});
  assert.equal(f.fetches[0][1].redirect, "error");
  // Saved body is reused only at its exact entry/version binding, never from an unversioned hash index.
  assert.equal((await f.ops.pull(f.input)).ok, true);
  assert.equal(f.fetches.length, 1);
  f.setHead({
    generation: 1,
    entries: [row(9n, { updatedSeq: 10n, blobHash: "opaque-not-a-digest" })],
  });
  assert.equal((await f.ops.pull(f.input)).ok, true);
  assert.equal(f.fetches.length, 2);
});
it("omitted reread can discover blob ref while retaining both original and reread evidence", async () => {
  const f = fixture();
  f.setExact({ generation: 1, entries: [row(9n, { blobHash: "blob-v1" })] });
  assert.equal((await f.ops.pull(f.input)).ok, true);
  const e = f.entries()[0];
  assert.equal(e.blob_hash, undefined);
  assert.equal(e.hydration.remote_blob_ref, "blob-v1");
  assert.ok(e.hydration.reread.raw);
  assert.equal(e.hydration.reread.raw.body, undefined);
  assert.ok(e.hydration.object_rel);
  assert.equal(e.hydration.body_base64, undefined);
  assert.ok(
    e.hydration.reread.wire_base64 || e.hydration.reread.content_sha256,
  );
});
for (const [name, edit] of [
  ["missing", () => []],
  ["duplicate", (r: any) => [r, r]],
  ["wrong path", (r: any) => [{ ...r, relPath: "blobs/other" }]],
  ["expired", (r: any) => [{ ...r, expiresAtMs: BigInt(Date.now() - 1) }]],
  ["missing expiry", (r: any) => [{ ...r, expiresAtMs: undefined }]],
  ["file URL", (r: any) => [{ ...r, url: "file:///etc/passwd" }]],
  [
    "URL credentials",
    (r: any) => [{ ...r, url: "https://user:pass@body.example/" }],
  ],
  ["http URL", (r: any) => [{ ...r, url: "http://body.example/" }]],
] as const)
  it(`blob presign rejects ${name} before fetching`, async () => {
    const f = fixture();
    f.setHead({ generation: 1, entries: [row(9n, { blobHash: "blob-1" })] });
    f.setPresign((req: any) => ({
      instructions: edit({
        relPath: req.relPaths[0],
        url: "https://body.example/?signature=BODY_URL_DO_NOT_LOG",
        expiresAtMs: BigInt(Date.now() + 120000),
      }),
    }));
    const r = await f.ops.pull(f.input);
    assert.equal(r.code, "partial");
    assert.equal(f.fetches.length, 0);
    assert.equal(JSON.stringify(r).includes("BODY_URL_DO_NOT_LOG"), false);
    assert.equal(f.entries()[0].hydration.status, "error");
  });
it("403 re-presigns once then succeeds, repeated 403 never loops", async () => {
  for (const succeed of [true, false]) {
    const f = fixture();
    f.setHead({ generation: 1, entries: [row(9n, { blobHash: "v1" })] });
    let n = 0;
    f.setFetch(async () =>
      ++n === 1 || !succeed
        ? new Response(null, { status: 403 })
        : new Response(bytes()),
    );
    const r = await f.ops.pull(f.input);
    assert.equal(r.ok, succeed);
    assert.equal(n, 2);
    assert.equal(f.calls.filter((x) => x[0] === "presign").length, 2);
  }
});
it("private IP store target is rejected by production HTTPS policy", async () => {
  const f = fixture();
  f.setHead({ generation: 1, entries: [row(9n, { blobHash: "v1" })] });
  f.setPresign((r: any) => ({
    instructions: [
      {
        relPath: r.relPaths[0],
        url: "https://127.0.0.1/test",
        expiresAtMs: BigInt(Date.now() + 120000),
      },
    ],
  }));
  const ops = new SyncOps(f.client, "https://api.example", true);
  assert.equal((await ops.pull(f.input)).code, "partial");
  assert.equal(f.entries()[0].decoded, undefined);
});
for (const source of ["omitted", "blob"] as const)
  it(`${source} oversized body stays partial and cannot decode`, async () => {
    const f = fixture();
    if (source === "omitted")
      f.setExact({
        generation: 1,
        entries: [row(9n, { body: bytes("x".repeat(2000)) })],
      });
    else {
      f.setHead({ generation: 1, entries: [row(9n, { blobHash: "v1" })] });
      f.setFetch(async () => new Response(bytes("x".repeat(2000))));
    }
    const r = await f.ops.pull({ ...f.input, hydrateMaxBodyBytes: 512 });
    assert.equal(r.code, "partial");
    assert.equal(f.entries()[0].decoded, undefined);
    assert.equal(f.entries()[0].hydration.status, "error");
  });
it("corrupt JSON bytes are preserved as evidence but decoder failure is not exit partial", async () => {
  const f = fixture();
  f.setExact({
    generation: 1,
    entries: [row(9n, { body: Buffer.from("{bad json") })],
  });
  const r = await f.ops.pull(f.input);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.code, "ok");
  const e = f.entries()[0];
  assert.equal(e.hydration.status, "fetched");
  assert.equal(e.decode_status, "opaque");
  assert.equal(e.decoded, undefined);
  assert.match(e.hydration.reason, /decoder:/);
  assert.equal(f.state().hydration.decode_failed, 1);
  assert.equal(f.state().body_partial, false);
  assert.equal(f.state().body_coverage.hydrated_version_bound, 1);
  assert.equal(f.state().body_coverage.decoded, 0);
  assert.equal(e.hydration.body_base64, undefined);
  assert.ok(e.hydration.object_rel);
  assert.equal(e.hydration.reread?.raw?.body, undefined);
});
it("shared hydration RPC budget bounds N+1 and failed reads retry on next pull", async () => {
  const f = fixture();
  f.setHead({ generation: 1, entries: [row(), row(8n)] });
  const r = await f.ops.pull({ ...f.input, maxHydrateRequests: 1 });
  assert.equal(r.code, "partial");
  assert.equal(
    f.calls.filter((x) => x[0] === "list" && x[1].limit === 1).length,
    1,
  );
  assert.equal(
    f.entries().find((e) => e.seq === "8").hydration.reason,
    "hydrate_rpc_budget",
  );
  f.setExact({
    generation: 1,
    entries: [row(8n, { body: bytes("重试正文") })],
  });
  assert.equal((await f.ops.pull(f.input)).ok, true);
  assert.equal(f.entries().find((e) => e.seq === "8").decoded.text, "重试正文");
});
it("global hydrate byte budget accounts failed streams and all presign/relist response bytes", async () => {
  const f = fixture();
  f.setHead({
    generation: 1,
    entries: [row(9n, { blobHash: "v1" }), row(8n, { blobHash: "v2" })],
  });
  f.setFetch(async () => new Response(bytes("x".repeat(1000))));
  const r = await f.ops.pull({
    ...f.input,
    hydrateMaxBytes: 600,
    hydrateMaxBodyBytes: 512,
  });
  assert.equal(r.code, "partial");
  assert.equal(f.fetches.length, 1);
  assert.equal((r.data as any).hydrate_requests, 1);
  assert.ok((r.data as any).hydrate_bytes >= 600);
});
it("cached hydration cannot cross scope/session/version or survive bytes/hash tampering", async () => {
  const f = fixture();
  assert.equal((await f.ops.pull(f.input)).ok, true);
  const e = f.entries()[0];
  for (const delta of [
    { session_id: "other" },
    { agent_id: "other" },
    { generation: 2 },
    { updated_seq: "10" },
    { entry_id: "other-entry" },
    { blob_hash: "new-ref" },
    { hydration: { ...e.hydration, format_version: 2 } },
    {
      hydration: {
        ...e.hydration,
        body_base64: bytes("tamper").toString("base64"),
      },
    },
    { hydration: { ...e.hydration, body_base64: 42 } },
  ])
    assert.equal(decodeStored({ ...e, ...delta }).decoded, undefined);
  const n = f.calls.length;
  assert.equal(
    (await f.ops.pull({ ...f.input, accountId: "another-account" })).ok,
    false,
  );
  assert.equal(f.calls.length, n);
});
it("crash after body-object commit leaves old entries valid and next pull recovers", async () => {
  const f = fixture();
  f.setHead({ generation: 1, entries: [row(9n, { blobHash: "v1" })] });
  assert.equal((await f.ops.pull({ ...f.input, hydrate: "off" })).ok, true);
  const original = Archive.prototype.atomic;
  let fail = true;
  Archive.prototype.atomic = function (rel, text) {
    if (fail && rel.endsWith("entries.jsonl")) {
      fail = false;
      throw new Error("simulated crash");
    }
    return original.call(this, rel, text);
  };
  try {
    assert.equal((await f.ops.pull(f.input)).ok, false);
  } finally {
    Archive.prototype.atomic = original;
  }
  assert.equal(f.entries()[0].hydration, undefined);
  assert.equal((await f.ops.status({ dir: f.dir })).ok, true);
  assert.equal((await f.ops.pull(f.input)).ok, true);
  assert.equal(
    f.entries()[0].decoded.text,
    "正文补全测试 中文 HYDRATED_BODY_OK",
  );
});
it("MCP hydration shares gates, strict enums and bounded budgets", async () => {
  const f = fixture(),
    cfg = {
      root: f.dir,
      accountId: "u",
      teamId: "none",
      acknowledgeUnverifiedScope: true,
      allowLocalWrites: true,
    };
  assert.equal(
    buildTools({ readOnly: true, sync: cfg }).some(
      (t) => t.name === "sync_pull",
    ),
    false,
  );
  assert.equal(
    buildTools({ sync: { ...cfg, allowLocalWrites: false } }).some(
      (t) => t.name === "sync_pull",
    ),
    false,
  );
  const tool = buildTools({ sync: cfg }).find((t) => t.name === "sync_pull")!;
  for (const bad of [
    { hydrate: "all" },
    { hydrate: "missing", max_hydrate_requests: 257 },
    { hydrate_max_body_bytes: BODY_DECODE_MAX + 1 },
    { hydrate_max_bytes: 0 },
    { path: "/private" },
  ])
    assert.equal(
      tool.inputSchema.safeParse({ agent_id: "a", ...bad }).success,
      false,
    );
  const r = await tool.handler({ sync: f.ops } as any, {
    agent_id: "a",
    session_id: "s",
    hydrate: "missing",
    max_pages: 1,
    max_hydrate_requests: 2,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(f.entries()[0].hydration.status, "fetched");
});
it("generation zero omitted reread keeps App scope convention and exact ID validation", async () => {
  const f = fixture();
  f.setHead({ generation: 0, entries: [row(9n, { entryId: "e-1" })] });
  f.setExact({
    generation: 0,
    entries: [row(9n, { entryId: "other", body: bytes() })],
  });
  assert.equal((await f.ops.pull(f.input)).code, "partial");
  const req = f.calls.find((x) => x[0] === "list" && x[1].limit === 1)[1];
  assert.equal(req.generation, 0);
  assert.equal(req.sessionId, "s");
});
it("opaque blob path traversal and arbitrary URLs in hash are never presigned", async () => {
  for (const ref of [
    "../private",
    "https://other.example/body",
    "/tmp/body",
    "..",
    "a\\b",
    "a%2fb",
  ]) {
    const f = fixture();
    f.setHead({ generation: 1, entries: [row(9n, { blobHash: ref })] });
    assert.equal((await f.ops.pull(f.input)).code, "partial");
    assert.equal(f.calls.filter((x) => x[0] === "presign").length, 0);
  }
});
it("stalled blob stream respects shared deadline and leaves no staging file", async () => {
  const f = fixture();
  f.setHead({ generation: 1, entries: [row(9n, { blobHash: "v1" })] });
  let canceled = false;
  f.setFetch(
    async () =>
      new Response(
        new ReadableStream({
          pull: () => new Promise(() => {}),
          cancel() {
            canceled = true;
          },
        }),
      ),
  );
  const start = Date.now();
  const r = await f.ops.pull({ ...f.input, timeoutMs: 70 });
  assert.equal(r.code, "partial");
  assert.ok(Date.now() - start < 1500);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(canceled, true);
  const stage = path.join(f.dir, ".sync/staging");
  assert.deepEqual(fs.readdirSync(stage), []);
});
it("oversized content length rejects before body reading; HTTP404/206 do not become bodies", async () => {
  for (const response of [
    new Response(bytes(), {
      headers: { "content-length": String(BODY_DECODE_MAX + 1) },
    }),
    new Response(null, { status: 404 }),
    new Response(bytes(), { status: 206 }),
  ]) {
    const f = fixture();
    f.setHead({ generation: 1, entries: [row(9n, { blobHash: "v1" })] });
    f.setFetch(async () => response);
    assert.equal((await f.ops.pull(f.input)).code, "partial");
    assert.equal(f.entries()[0].hydration.body_base64, undefined);
    assert.equal(f.calls.filter((x) => x[0] === "presign").length, 1);
  }
});
it("body objects refuse symlink/hardlink targets without overwriting external files", async () => {
  for (const link of ["symlink", "hardlink"]) {
    const f = fixture();
    f.setHead({ generation: 1, entries: [row(9n, { blobHash: "v1" })] });
    assert.equal((await f.ops.pull({ ...f.input, hydrate: "off" })).ok, true);
    const a = new Archive(f.dir),
      external = path.join(f.dir, "external-test"),
      { createHash } = await import("node:crypto"),
      digest = createHash("sha256").update(bytes()).digest("hex"),
      obj = a.file(`bodies/objects/sha256-${digest}`, true);
    fs.writeFileSync(external, "untouched", { mode: 0o600 });
    if (link === "symlink") fs.symlinkSync(external, obj);
    else fs.linkSync(external, obj);
    assert.equal((await f.ops.pull(f.input)).code, "partial");
    assert.equal(fs.readFileSync(external, "utf8"), "untouched");
    assert.equal(f.entries()[0].decoded, undefined);
  }
});
it("fresh same-version inline observation supersedes hydrated blob instead of cached hydration", async () => {
  const f = fixture();
  f.setHead({
    generation: 1,
    entries: [row(9n, { blobHash: "v1", bodyOmitted: false })],
  });
  assert.equal((await f.ops.pull(f.input)).ok, true);
  await f.ops.pull({ ...f.input, hydrate: "off" });
  f.setHead({
    generation: 1,
    entries: [
      row(9n, {
        blobHash: "v1",
        bodyOmitted: false,
        body: bytes("INLINE_FRESH"),
      }),
    ],
  });
  assert.equal((await f.ops.pull(f.input)).ok, true);
  assert.equal(f.entries()[0].decoded.text, "INLINE_FRESH");
  assert.equal(f.entries()[0].hydration, undefined);
});
it("unknown JSON UI shapes remain opaque with independent hydrated/decoded coverage", async () => {
  const f = fixture();
  f.setHead({ generation: 1, entries: [row(9n, { blobHash: "v1" })] });
  f.setFetch(
    async () =>
      new Response(
        JSON.stringify({
          id: "future",
          kind: "future-widget",
          text: "not a validated message",
        }),
      ),
  );
  assert.equal((await f.ops.pull(f.input)).ok, true);
  const e = f.entries()[0];
  assert.equal(e.hydration.status, "fetched");
  assert.equal(e.decoded, undefined);
  assert.equal(f.state().body_coverage.unavailable_or_unsupported, 1);
  assert.equal(f.state().body_partial, false);
  const inline = fixture();
  inline.setHead({
    generation: 1,
    entries: [row(9n, { body: Buffer.from("{invalid"), bodyOmitted: false })],
  });
  const ir = await inline.ops.pull(inline.input);
  assert.equal(ir.ok, true);
  assert.equal(inline.state().hydration.inline_decode_failed, 1);
  assert.equal(inline.state().body_partial, false);
});
it("global pull bytes bound further hydration RPC even if hydrate allowance remains", async () => {
  const f = fixture();
  f.setExact({
    generation: 1,
    entries: [row(9n, { body: bytes("x".repeat(2000)) })],
  });
  const r = await f.ops.pull({
    ...f.input,
    maxBytes: 700,
    hydrateMaxBytes: 1024 * 1024,
  });
  assert.equal(r.code, "partial");
  assert.ok((r.data as any).hydrate_bytes > 0);
  assert.equal(f.entries()[0].decoded, undefined);
});

it("supplemental body storage budget cannot prevent original row archival", async () => {
  const f = fixture();
  await f.ops.pull({ ...f.input, hydrate: "off" });
  const e = f.entries()[0],
    originalWire = e.wire_base64;
  const result = await hydrateEntries([e], {
    archive: new Archive(f.dir),
    fetchImpl: async () => new Response(bytes()),
    call: async () => ({
      generation: 1,
      entries: [row(9n, { body: bytes("x".repeat(10000)) })],
    }),
    maxRequests: 1,
    maxBodyBytes: BODY_DECODE_MAX,
    budget: { bytes: 0, maxBytes: 1024 * 1024, deadline: Date.now() + 5000 },
    maxArchiveBytes: 2000,
  });
  assert.equal(result.archive_body_skipped, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.recovered, 0);
  assert.equal(e.hydration.status, "error");
  assert.equal(e.hydration.reason, "archive_body_budget");
  assert.equal(e.wire_base64, originalWire);
  assert.equal(e.body_omitted, true);
  assert.equal(e.decoded, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(e)) < 2000);
});
it("manifest scope substitution invalidates cached bodies even at identical entry identity", async () => {
  const f = fixture();
  assert.equal((await f.ops.pull(f.input)).ok, true);
  const a = new Archive(f.dir),
    m = a.json("manifest.json");
  m.scope.account_id = "other";
  a.writeJson("manifest.json", m);
  const status: any = await f.ops.status({ dir: f.dir });
  assert.equal(status.ok, true);
  assert.equal(status.data.sessions[0].body_coverage.hydrated_version_bound, 0);
  assert.equal((await f.ops.render({ dir: f.dir })).ok, true);
  const md = a.read(
    `derived/${component("a")}/${component("s")}/transcript.md`,
  )!;
  assert.equal(md.includes("正文补全测试 中文"), false);
  assert.equal(md.includes("invalid_stored_hydration"), true);
});

it("unknown-size body validates final Content-Length, not just header budget", async () => {
  const f = fixture();
  f.setHead({ generation: 1, entries: [row(9n, { blobHash: "v1" })] });
  f.setFetch(
    async () => new Response(bytes(), { headers: { "content-length": "1" } }),
  );
  assert.equal((await f.ops.pull(f.input)).code, "partial");
  assert.equal(f.entries()[0].hydration.status, "error");
  assert.equal(f.entries()[0].decoded, undefined);
});
it("unknown future hydration versions remain untouched and never cause supplemental reads", async () => {
  const f = fixture();
  await f.ops.pull({ ...f.input, hydrate: "off" });
  const e = f.entries()[0];
  e.hydration = {
    format_version: 2,
    status: "fetched",
    future_metadata: { keep: "evidence" },
  };
  const original = JSON.stringify(e.hydration);
  let reads = 0;
  const result = await hydrateEntries([e], {
    archive: new Archive(f.dir),
    fetchImpl: async () => {
      reads++;
      throw new Error("no fetch");
    },
    call: async () => {
      reads++;
      throw new Error("no rpc");
    },
    maxRequests: 32,
    maxBodyBytes: BODY_DECODE_MAX,
    budget: { bytes: 0, maxBytes: 1024 * 1024, deadline: Date.now() + 5000 },
  });
  assert.equal(result.failed, 1);
  assert.equal(reads, 0);
  assert.equal(JSON.stringify(e.hydration), original);
  assert.equal(decodeStored(e).decode_reason, "invalid_stored_hydration");
});

it("P2 starve: deterministic old failures do not exhaust budget so newer seq hydrates", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-starve-"));
  let headRows = Array.from({ length: 40 }, (_, i) => row(BigInt(i + 1)));
  const body = bytes("NEW_BODY");
  let calls = 0;
  const client: any = {
    async listGrokBotAgents() {
      return { agents: [{ id: "a" }] };
    },
    async listGrokBotAgentSessions() {
      return { sessions: [{ sessionId: "s", agentId: "a" }] };
    },
    async listGrokBotTranscriptEntries(req: any) {
      if (req.limit === 1) {
        calls++;
        const s = req.beforeSeq - 1n;
        if (s <= 40n)
          return {
            generation: 1,
            entries: [row(s, { updatedSeq: s + 1000n, bodyOmitted: true })],
          };
        return {
          generation: 1,
          entries: [row(s, { body, bodyOmitted: false })],
        };
      }
      return req.beforeSeq === undefined
        ? { generation: 1, entries: headRows }
        : { generation: 1, entries: [] };
    },
    async presignSandBoxStoreReads() {
      throw new Error("no");
    },
  };
  const ops = new SyncOps(
    client,
    "https://api.example",
    true,
    async () => new Response(""),
  );
  const input: any = {
    dir,
    agentId: "a",
    sessionId: "s",
    accountId: "u",
    teamId: "none",
    acknowledgeUnverifiedScope: true,
    maxPages: 1,
    pageSize: 500,
    hydrate: "missing",
  };
  const round0: any = await ops.pull(input);
  assert.equal(round0.ok, false);
  assert.equal(round0.code, "partial");
  assert.ok((round0.data as any).sessions[0].hydration.version_adopted > 0);
  headRows = [row(41n)];
  // Round 1: alternating backfill may not see seq41 yet; must skip deterministic rows.
  const round1: any = await ops.pull(input);
  assert.ok(
    (round1.data as any).sessions[0].hydration.skipped_deterministic >= 32,
  );
  // Round 2: head refresh observes seq41; old never-retry rows must not starve it.
  const round2: any = await ops.pull(input);
  assert.equal(round2.ok, true, JSON.stringify(round2));
  const a = new Archive(dir);
  const text = a.read(
    `bots/${component("a")}/sessions/${component("s")}/generations/1/entries.jsonl`,
  )!;
  const rows = text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const last = rows.find((x: any) => x.seq === "41");
  assert.equal(rows.length, 41);
  assert.equal(last?.decoded?.text, "NEW_BODY");
  assert.equal(last?.hydration?.status, "fetched");
  assert.notEqual(last?.hydration?.reason, "hydrate_rpc_budget");
  assert.equal(
    (round2.data as any).sessions[0].hydration.skipped_deterministic,
    40,
  );
  assert.equal((round2.data as any).sessions[0].hydration.failed, 0);
});

it("P3 reread stores object ref without triplicate body_base64 in JSONL", async () => {
  const f = fixture();
  const big = "中文".repeat(2000);
  f.setExact({
    generation: 1,
    entries: [row(9n, { body: bytes(big) })],
  });
  assert.equal((await f.ops.pull(f.input)).ok, true);
  const e = f.entries()[0];
  const line = JSON.stringify(e);
  assert.equal(e.hydration.body_base64, undefined);
  assert.ok(e.hydration.object_rel);
  assert.equal(e.hydration.reread?.raw?.body, undefined);
  // One content-addressed object on disk; JSONL must not embed the body three times.
  const occurrences =
    line.split(
      Buffer.from(
        JSON.stringify({
          id: "ui-1",
          kind: "message",
          content: big,
          role: "assistant",
        }),
      ).toString("base64"),
    ).length - 1;
  assert.equal(occurrences, 0);
  assert.ok(!JSON.stringify(e.hydration).includes('"body_base64"'));
  // wire evidence may retain protobuf bytes once; forbid the old 3x JSON body_base64 pattern.
  assert.ok(
    Buffer.byteLength(JSON.stringify(e.hydration)) < Buffer.byteLength(big) * 4,
  );
  assert.equal(e.decoded.text, big);
});

it("deterministic same-version failures skip RPC on later pulls", async () => {
  const f = fixture();
  f.setExact({ generation: 1, entries: [] });
  assert.equal((await f.ops.pull(f.input)).code, "partial");
  const n = f.calls.filter((x) => x[0] === "list" && x[1].limit === 1).length;
  assert.equal(n, 1);
  assert.equal(f.entries()[0].hydration.retry, "never");
  assert.equal((await f.ops.pull(f.input)).ok, true);
  assert.equal(
    f.calls.filter((x) => x[0] === "list" && x[1].limit === 1).length,
    1,
  );
  assert.equal(
    (await f.ops.pull(f.input)).data.sessions[0].hydration
      .skipped_deterministic,
    1,
  );
});
