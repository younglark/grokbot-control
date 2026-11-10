import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SyncOps, entryRecord } from "../src/sync/core.js";
import { Archive, component, hash } from "../src/sync/fs.js";
import {
  assertRemotePath,
  acceptStoreRead,
  objectRel,
  refRel,
  sha256Hex,
  downloadToStage,
} from "../src/sync/attachments.js";
import { publicAddress } from "../src/sync/download-policy.js";
import { GrokBotTranscriptEntry } from "../vendor/proto-gen/aiserver.v1_pb.js";
import { buildTools } from "../src/mcp/tools.js";
const rp =
  "/home/box/agent-data/agents/test-agent/attachments/" +
  "a".repeat(64) +
  ".txt";
const payload = Buffer.from("测试文本 GBC_ATTACHMENT_OK");
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gbc-att-v2-"));
const gd = `bots/${component("a")}/sessions/${component("s")}/generations/1`;
const scope = {
  backend: "https://example.test",
  account_id: "user",
  team_id: "none",
  assurance: "operator_asserted_unverified",
};
const input = (dir: string) => ({
  dir,
  agentId: "a",
  sessionId: "s",
  accountId: "user",
  teamId: "none",
  acknowledgeUnverifiedScope: true,
});
function seed(dir: string, kind = "user-attachment", remote = rp) {
  const a = new Archive(dir, true);
  a.writeJson("manifest.json", {
    format_version: 1,
    scope,
    sessions: [{ agent_id: "a", session_id: "s" }],
  });
  const body =
    kind === "send-message"
      ? {
          kind,
          id: "b",
          message: {
            type: "attachment",
            url: remote,
            file_name: "中文 名称.txt",
          },
        }
      : { kind, id: "b", file_path: remote, file_name: "中文 名称.txt" };
  const e = entryRecord(
    new GrokBotTranscriptEntry({
      seq: 1n,
      updatedSeq: 1n,
      entryKind: kind,
      body: Buffer.from(JSON.stringify(body)),
    }),
    "a",
    "s",
    1,
  );
  const text = JSON.stringify(e) + "\n";
  a.atomic(gd + "/entries.jsonl", text);
  a.writeJson(gd + "/state.json", { entries_sha256: hash(text) });
  a.writeJson(
    `bots/${component("a")}/sessions/${component("s")}/session.json`,
    { current_generation: 1 },
  );
  return a;
}
function read(extra = {}) {
  return {
    path: rp,
    outcome: 1,
    url: "https://store.example/download?signature=DO_NOT_LOG",
    sizeBytes: BigInt(payload.length),
    expiresAtMs: BigInt(Date.now() + 120000),
    etag: "v1",
    ...extra,
  };
}
it("App absolute aliases and strict file URLs canonicalize; arbitrary local files/traversal refused", () => {
  assert.equal(assertRemotePath(rp.replace("agent-data", "sand-data")), rp);
  assert.equal(assertRemotePath("file://" + rp), rp);
  assert.equal(
    refRel("a", rp, "s").includes(Buffer.from(rp).toString("base64url")),
    false,
  );
  for (const p of [
    "/etc/passwd",
    "file:///etc/passwd",
    rp.replace("/attachments/", "/../attachments/"),
    "file://host" + rp,
    "file://" + rp + "?x",
    "file://" + rp.replace("/agents/", "%2fagents/"),
    "uploads/file.txt",
  ])
    assert.throws(() => assertRemotePath(p));
  assert.notEqual(refRel("a", rp, "s"), refRel("a", rp, "other"));
});
it("STORE requires safe metadata and usable URL without credentials", () => {
  assert.equal(acceptStoreRead(rp, read(), Date.now()).ok, true);
  for (const extra of [
    { etag: "" },
    { sizeBytes: -1n },
    { sizeBytes: "99999999999999999999" },
    { expiresAtMs: 0n },
    { expiresAtMs: "bogus" },
    { url: "https://u:p@store.example/x" },
    { url: "http://store/x" },
    { url: "https://store/x#frag" },
  ])
    assert.equal(acceptStoreRead(rp, read(extra), Date.now()).ok, false);
});
for (const kind of ["user-attachment", "send-message"])
  it(`stream downloads ${kind}, scoped ref and offline render`, async () => {
    const dir = temp(),
      a = seed(dir, kind);
    let calls = 0;
    const ops = new SyncOps(
      {
        resolveGrokBotAttachmentReads: async (r: any) => {
          calls++;
          assert.equal(r.sessionId, "s");
          assert.deepEqual(r.paths, [rp]);
          return { reads: [read()] };
        },
      },
      scope.backend,
      true,
      async (_u, init) => {
        assert.equal(new Headers(init?.headers).has("authorization"), false);
        return new Response(payload);
      },
    );
    const result = await ops.attachments(input(dir));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(calls, 1);
    const ref = a.json(refRel("a", rp, "s"));
    assert.equal(ref.status, "ok");
    assert.deepEqual(
      fs.readFileSync(path.join(dir, ref.relative_path)),
      payload,
    );
    assert.equal(ref.content_sha256, sha256Hex(payload));
    assert.equal(JSON.stringify(result).includes("DO_NOT_LOG"), false);
    assert.equal(JSON.stringify(ref).includes("DO_NOT_LOG"), false);
    assert.equal((await ops.render({ dir })).ok, true);
    assert.ok(
      a
        .read(`derived/${component("a")}/${component("s")}/transcript.md`)
        ?.includes(ref.relative_path),
    );
  });
it("each invocation resolves; conditional 304 reuses integrity-checked object; updated etag gets new object", async () => {
  const dir = temp(),
    a = seed(dir);
  let etag = "v1",
    body = payload,
    resolves = 0,
    fetches = 0;
  const ops = new SyncOps(
    {
      resolveGrokBotAttachmentReads: async () => {
        resolves++;
        return { reads: [read({ etag, sizeBytes: BigInt(body.length) })] };
      },
    },
    scope.backend,
    true,
    async (_u, init) => {
      fetches++;
      const e = new Headers(init?.headers).get("if-none-match");
      return e === `"${etag}"`
        ? new Response(null, { status: 304 })
        : new Response(body);
    },
  );
  assert.equal((await ops.attachments(input(dir))).ok, true);
  const r = await ops.attachments(input(dir));
  assert.equal(r.ok, true);
  assert.equal((r.data as any).results[0].reason, "not_modified");
  etag = "v2";
  body = Buffer.from("updated 中文");
  assert.equal((await ops.attachments(input(dir))).ok, true);
  assert.equal(resolves, 3);
  assert.equal(fetches, 3);
  assert.equal(a.json(refRel("a", rp, "s")).content_sha256, sha256Hex(body));
  assert.ok(fs.existsSync(path.join(dir, objectRel("a", sha256Hex(payload)))));
});
it("scope mismatch fails before Resolve; legacy unscoped refs ignored", async () => {
  const dir = temp();
  seed(dir);
  let calls = 0;
  const ops = new SyncOps(
    {
      resolveGrokBotAttachmentReads: async () => {
        calls++;
        return { reads: [read()] };
      },
    },
    scope.backend,
    true,
    async () => new Response(payload),
  );
  const wrong = await ops.attachments({ ...input(dir), accountId: "other" });
  assert.equal(wrong.ok, false);
  assert.equal(calls, 0);
  const noack = await ops.attachments({
    ...input(dir),
    acknowledgeUnverifiedScope: false,
  });
  assert.equal(noack.ok, false);
  assert.equal(
    (await new SyncOps({}, "https://other.test", true).attachments(input(dir)))
      .ok,
    false,
  );
});
it("403 re-resolves once; duplicate resolve paths fail closed without downloading", async () => {
  const dir = temp();
  seed(dir);
  let resolves = 0,
    gets = 0;
  const ops = new SyncOps(
    {
      resolveGrokBotAttachmentReads: async () => {
        resolves++;
        return { reads: [read()] };
      },
    },
    scope.backend,
    true,
    async () => {
      gets++;
      return gets === 1
        ? new Response(null, { status: 403 })
        : new Response(payload);
    },
  );
  assert.equal((await ops.attachments(input(dir))).ok, true);
  assert.equal(resolves, 2);
  const d = temp();
  seed(d);
  const duplicate = new SyncOps(
    {
      resolveGrokBotAttachmentReads: async () => ({ reads: [read(), read()] }),
    },
    scope.backend,
    true,
    async () => {
      throw new Error("must not fetch");
    },
  );
  assert.equal(
    (await duplicate.attachments(input(d))).code,
    "attachments_failed",
  );
});
for (const outcome of [2, 3])
  it(`outcome ${outcome} is structured failure, not top-level false success`, async () => {
    const dir = temp(),
      a = seed(dir);
    const ops = new SyncOps(
      {
        resolveGrokBotAttachmentReads: async () => ({
          reads: [read({ outcome })],
        }),
      },
      scope.backend,
      true,
      async () => {
        throw new Error("no fetch");
      },
    );
    const r = await ops.attachments(input(dir));
    assert.equal(r.ok, false);
    assert.equal(
      a.json(refRel("a", rp, "s")).status,
      outcome === 2 ? "not_in_store" : "no_storage",
    );
  });
it("oversized streaming response cancels; failed bytes count in total; no staging residue", async () => {
  const dir = temp(),
    a = seed(dir);
  let cancelled = false;
  const fetcher = async () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(100));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  const ops = new SyncOps(
    {
      resolveGrokBotAttachmentReads: async () => ({
        reads: [read({ sizeBytes: 3n })],
      }),
    },
    scope.backend,
    true,
    fetcher,
  );
  const r = await ops.attachments({
    ...input(dir),
    maxBytes: 50,
    maxFileBytes: 40,
  });
  assert.equal(r.ok, false);
  assert.equal((r.error?.details as any).bytes_consumed, 100);
  assert.equal(cancelled, true);
  assert.equal(a.json(refRel("a", rp, "s")).status, "error");
  assert.deepEqual(fs.readdirSync(path.join(dir, ".sync/staging")), []);
});
it("full GET rejects unsolicited 206; global deadline bounds streaming", async () => {
  const sink = { write: () => {}, discard: () => {} };
  await assert.rejects(
    downloadToStage("https://store/x", {
      maxBytes: 10,
      expectedSize: 1,
      budget: { bytes: 0, maxBytes: 10, deadline: Date.now() + 1000 },
      sink,
      fetchImpl: async () => new Response("x", { status: 206 }),
    }),
  );
  await assert.rejects(
    downloadToStage("https://store/x", {
      maxBytes: 10,
      expectedSize: 1,
      budget: { bytes: 0, maxBytes: 10, deadline: Date.now() - 1 },
      sink,
      fetchImpl: async () => new Response("x"),
    }),
  );
});
it("public target policy rejects loopback/private/mapped/reserved addresses", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "fd00::1",
    "fe80::1",
    "224.0.0.1",
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress("8.8.8.8"), true);
  assert.equal(publicAddress("2606:4700::1111"), true);
});
it("unsupported external links never fetched; MCP fixed root/read-only gate retained; pure dryrun", async () => {
  const dir = temp();
  seed(dir, "send-message", "https://external.example/file");
  let net = 0;
  const ops = new SyncOps({}, scope.backend, true, async () => {
    net++;
    return new Response("x");
  });
  assert.equal((await ops.attachments(input(dir))).ok, false);
  assert.equal(net, 0);
  assert.equal(
    (await ops.attachments({ ...input("/absent/private/root"), dryRun: true }))
      .ok,
    true,
  );
  const options = {
    root: dir,
    allowLocalWrites: true,
    accountId: "user",
    teamId: "none",
    acknowledgeUnverifiedScope: true,
  };
  assert.equal(
    buildTools({ readOnly: true, sync: options }).some(
      (t) => t.name === "sync_attachments",
    ),
    false,
  );
  assert.equal(
    buildTools({ sync: { ...options, allowLocalWrites: false } }).some(
      (t) => t.name === "sync_attachments",
    ),
    false,
  );
});
it("stalled stream read is aborted by command deadline; no staged bytes published", async () => {
  const sink = {
    write: () => {
      throw new Error("no writes");
    },
    discard: () => {},
  };
  let cancelled = false;
  const started = Date.now();
  await assert.rejects(
    downloadToStage("https://store/x", {
      maxBytes: 10,
      expectedSize: 1,
      budget: { bytes: 0, maxBytes: 10, deadline: Date.now() + 30 },
      sink,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
    }),
  );
  assert.ok(Date.now() - started < 1000);
  assert.equal(cancelled, true);
});
it("corrupted local object must not emit conditional header or accept 304", async () => {
  const dir = temp(),
    a = seed(dir);
  let conditional = false;
  const ops = new SyncOps(
    { resolveGrokBotAttachmentReads: async () => ({ reads: [read()] }) },
    scope.backend,
    true,
    async (_u, init) => {
      conditional = new Headers(init?.headers).has("if-none-match");
      return new Response(payload);
    },
  );
  await ops.attachments(input(dir));
  const ref = a.json(refRel("a", rp, "s"));
  fs.writeFileSync(path.join(dir, ref.relative_path), "corrupted");
  assert.equal((await ops.attachments(input(dir))).ok, true);
  assert.equal(conditional, false);
});
it("attachment store paths cannot follow symlink into another location", async () => {
  const dir = temp(),
    a = seed(dir),
    outside = temp();
  const bot = path.join(dir, "bots", component("a"));
  fs.symlinkSync(outside, path.join(bot, "attachments"));
  const ops = new SyncOps(
    { resolveGrokBotAttachmentReads: async () => ({ reads: [read()] }) },
    scope.backend,
    true,
    async () => new Response(payload),
  );
  assert.equal((await ops.attachments(input(dir))).ok, false);
  assert.deepEqual(fs.readdirSync(outside), []);
});
it("MCP send/status permit omitted default session and still require message identifiers", () => {
  const tools = buildTools({ allowWrites: true }),
    send = tools.find((t) => t.name === "send_message")!,
    status = tools.find((t) => t.name === "get_send_status")!;
  assert.equal(
    send.inputSchema.safeParse({
      agent_id: "a",
      text: "fixed-test",
      dry_run: true,
    }).success,
    true,
  );
  assert.equal(
    status.inputSchema.safeParse({ agent_id: "a", message_id: "m" }).success,
    true,
  );
  assert.equal(status.inputSchema.safeParse({ agent_id: "a" }).success, false);
});
