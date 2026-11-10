import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SyncOps, entryRecord } from "../src/sync/core.js";
import { Archive, component, hash } from "../src/sync/fs.js";
import { buildTools } from "../src/mcp/tools.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ControlPlane } from "../src/ops/plane.js";
import { createRouterTransport } from "@connectrpc/connect";
import { GrokBotService } from "../vendor/proto-gen/svc_aiserver.v1.GrokBotService_connect.js";
import { MessageOps } from "../src/ops/message.js";
import { GrokBotTranscriptEntry } from "../vendor/proto-gen/aiserver.v1_pb.js";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gbc-sync-"));
const base = (dir: string) => ({
  dir,
  agentId: "a",
  accountId: "stable-user-1",
  teamId: "none",
  acknowledgeUnverifiedScope: true,
});
const row = (seq: string, updated = seq, extra = {}) =>
  new GrokBotTranscriptEntry({
    seq: BigInt(seq),
    updatedSeq: BigInt(updated),
    entryKind: "message",
    ...extra,
  });
function fixture(dir = temp(), sessions = ["s"]) {
  const calls: any[] = [];
  let respond: (r: any) => any = (r) => ({
    generation: 1,
    entries: r.beforeSeq === undefined ? [row("2"), row("1")] : [],
  });
  const client = {
    async listGrokBotAgents() {
      calls.push("bots");
      return { agents: [{ id: "a", name: "demo" }] };
    },
    async listGrokBotAgentSessions() {
      calls.push("sessions");
      return {
        sessions: sessions.map((sessionId) => ({
          agentId: "a",
          sessionId,
          kind: 1,
          createdAtMs: 1n,
        })),
      };
    },
    async listGrokBotTranscriptEntries(req: any) {
      calls.push(req);
      return respond(req);
    },
  };
  const ops = new SyncOps(client, "https://example.test", true);
  return {
    dir,
    ops,
    calls,
    client,
    respond(f: typeof respond) {
      respond = f;
    },
  };
}
const gd = (s = "s", g = 1) =>
  `bots/${component("a")}/sessions/${component(s)}/generations/${g}`;
function entries(dir: string, s = "s", g = 1) {
  return new Archive(dir)
    .read(`${gd(s, g)}/entries.jsonl`)!
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((x) => JSON.parse(x));
}
function state(dir: string, s = "s", g = 1) {
  return new Archive(dir).json(`${gd(s, g)}/state.json`);
}

it("session-aware pagination is explicit, ordered numerically and never claims complete", async () => {
  const f = fixture();
  const r = await f.ops.pull({ ...base(f.dir), sessionId: "s" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((r.data as any).sessions[0].completeness, "unknown");
  assert.deepEqual(
    entries(f.dir).map((e) => e.seq),
    ["1", "2"],
  );
  const reqs = f.calls.filter((x) => typeof x !== "string");
  assert.equal(reqs[0].sessionId, "s");
  assert.equal(reqs[0].limit, 100);
  assert.equal(reqs[1].beforeSeq, 1n);
  assert.equal(reqs[1].generation, 1);
  assert.equal(state(f.dir).stop_reason, "empty_page_unverified");
});
it("repeat pull is idempotent; changed older entry is updated; missing entries never delete", async () => {
  const f = fixture();
  await f.ops.pull(base(f.dir));
  const text = new Archive(f.dir).read(`${gd()}/entries.jsonl`);
  await f.ops.pull(base(f.dir));
  assert.equal(new Archive(f.dir).read(`${gd()}/entries.jsonl`), text);
  f.respond((r) => ({
    generation: 1,
    entries:
      r.beforeSeq === undefined
        ? [row("1", "9", { body: new Uint8Array([0, 255]) })]
        : [],
  }));
  assert.equal((await f.ops.pull(base(f.dir))).ok, true);
  const es = entries(f.dir);
  assert.equal(es.length, 2);
  assert.equal(es[0].updated_seq, "9");
  assert.equal(es[0].body_base64, "AP8=");
  assert.equal(es[0].decode_status, "opaque");
});
it("missing entry IDs are supported; uint64 >2^53 round trips and no UTF8/encryption guessing", async () => {
  const f = fixture();
  f.respond((r) => ({
    generation: 4,
    entries:
      r.beforeSeq === undefined
        ? [
            row("9007199254740993", "18446744073709551615", {
              body: Buffer.from("apparently plaintext"),
            }),
            row("8", "8", {
              bodyOmitted: true,
              blobHash: "not-a-download-url",
            }),
          ]
        : [],
  }));
  await f.ops.pull(base(f.dir));
  const es = entries(f.dir, "s", 4);
  assert.equal(es[1].seq, "9007199254740993");
  assert.equal(es[1].updated_seq, "18446744073709551615");
  assert.equal(es[1].entry_id, undefined);
  assert.equal(es[1].decode_status, "opaque");
  assert.equal(es[1].encryption_status, "unknown");
  assert.ok(es[1].wire_base64);
  assert.equal(es[0].body_omitted, true);
  assert.equal(es[0].decode_status, "omitted");
  assert.equal(fs.existsSync(path.join(f.dir, "attachments")), false);
});
it("session isolation uses request context, not guessed message fields", async () => {
  const f = fixture(undefined, ["s", "../../other"]);
  assert.equal((await f.ops.pull(base(f.dir))).ok, true);
  assert.equal(entries(f.dir, "s").length, 2);
  assert.equal(entries(f.dir, "../../other")[0].session_id, "../../other");
  assert.equal(fs.existsSync(path.join(f.dir, "other")), false);
});
it("repeated page/boundary overlap stops safely; pages are bounded", async () => {
  const f = fixture();
  f.respond(() => ({ generation: 1, entries: [row("5")] }));
  assert.equal((await f.ops.pull({ ...base(f.dir), sessionId: "s" })).ok, true);
  assert.equal(
    state(f.dir).stop_reason,
    "cursor_no_progress_or_boundary_overlap",
  );
  assert.equal(
    f.calls.filter((x) => typeof x !== "string" && x.sessionId === "s").length,
    2,
  );
  const g = fixture();
  await g.ops.pull({ ...base(g.dir), sessionId: "s", maxPages: 1 });
  assert.equal(state(g.dir).stop_reason, "page_budget");
});
it("inclusive boundary / unordered pages / zero sequences do not infer completeness", async () => {
  const f = fixture();
  f.respond((r) => ({
    generation: 1,
    entries:
      r.beforeSeq === undefined ? [row("2"), row("5")] : [row("2"), row("1")],
  }));
  await f.ops.pull(base(f.dir));
  assert.equal(
    state(f.dir).stop_reason,
    "cursor_no_progress_or_boundary_overlap",
  );
  assert.deepEqual(
    entries(f.dir).map((e) => e.seq),
    ["2", "5"],
  );
  const z = fixture();
  z.respond(() => ({ generation: 1, entries: [row("0")] }));
  await z.ops.pull(base(z.dir));
  assert.equal(state(z.dir).stop_reason, "seq_zero_unverified");
});
it("generation change does not merge across generations or leave old generation current", async () => {
  const f = fixture();
  await f.ops.pull(base(f.dir));
  f.respond((r) => ({
    generation: r.beforeSeq === undefined ? 2 : 3,
    entries: [row("9")],
  }));
  const r = await f.ops.pull(base(f.dir));
  assert.equal(r.ok, true);
  assert.equal((r.data as any).sessions[0].published, false);
  assert.equal(entries(f.dir).length, 2);
  assert.equal(
    new Archive(f.dir).json(
      `bots/${component("a")}/sessions/${component("s")}/session.json`,
    ).current_generation,
    null,
  );
  assert.equal((await f.ops.render({ dir: f.dir })).ok, false);
  f.respond((r) => ({
    generation: 3,
    entries: r.beforeSeq === undefined ? [row("1")] : [],
  }));
  await f.ops.pull(base(f.dir));
  assert.equal(entries(f.dir, "s", 3).length, 1);
  assert.equal(entries(f.dir, "s", 1).length, 2);
});
it("scope mismatch, missing acknowledgement and invalid limits deny before remote RPC", async () => {
  const f = fixture();
  await f.ops.pull(base(f.dir));
  const count = f.calls.length;
  const r = await f.ops.pull({ ...base(f.dir), accountId: "other" });
  assert.equal(r.code, "denied");
  assert.equal(f.calls.length, count);
  assert.equal(
    (await f.ops.pull({ ...base(f.dir), acknowledgeUnverifiedScope: false }))
      .code,
    "denied",
  );
  assert.equal(
    (await f.ops.pull({ ...base(f.dir), maxPages: 0 })).code,
    "invalid_argument",
  );
});
it("dry run is pure even for absent roots; no RPC or file access/creation", async () => {
  const f = fixture(path.join(temp(), "absent"));
  const r = await f.ops.pull({ ...base(f.dir), dryRun: true });
  assert.equal(r.code, "dry_run");
  assert.equal(fs.existsSync(f.dir), false);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.ops.render({ dir: f.dir, dryRun: true })).ok, true);
  assert.equal(fs.existsSync(f.dir), false);
});
it("single-writer lock conflicts and is never auto removed", async () => {
  const f = fixture(),
    a = new Archive(f.dir);
  const release = a.lock();
  assert.equal((await f.ops.pull(base(f.dir))).code, "conflict");
  assert.equal(f.calls.length, 0);
  assert.ok(a.read(".sync/lock"));
  release();
  assert.equal((await f.ops.pull(base(f.dir))).ok, true);
  assert.equal(a.read(".sync/lock"), undefined);
});
it("files 0600 directories 0700; symlink root, ancestor, data or lock refuses escape", async () => {
  const f = fixture();
  await f.ops.pull(base(f.dir));
  assert.equal(fs.statSync(f.dir).mode & 0o777, 0o700);
  assert.equal(
    fs.statSync(path.join(f.dir, "manifest.json")).mode & 0o777,
    0o600,
  );
  const parent = temp(),
    linked = path.join(parent, "alias");
  fs.symlinkSync(f.dir, linked);
  assert.equal((await f.ops.status({ dir: linked })).code, "denied");
  const a = new Archive(f.dir),
    dest = a.file(`${gd()}/entries.jsonl`);
  fs.unlinkSync(dest);
  const outside = path.join(temp(), "outside");
  fs.writeFileSync(outside, "unchanged", { mode: 0o600 });
  fs.symlinkSync(outside, dest);
  assert.equal((await f.ops.pull(base(f.dir))).code, "denied");
  assert.equal(fs.readFileSync(outside, "utf8"), "unchanged");
});
it("lock symlinks and world-readable archive root are rejected", async () => {
  const f = fixture(),
    a = new Archive(f.dir);
  const p = a.file(".sync/lock", true);
  fs.symlinkSync(path.join(temp(), "missing"), p);
  assert.equal((await f.ops.pull(base(f.dir))).code, "denied");
  const d = temp();
  fs.chmodSync(d, 0o755);
  assert.equal(
    (await new SyncOps({}, "https://example.test").status({ dir: d })).code,
    "denied",
  );
});
it("IO crash after data rename leaves detectable checkpoint mismatch; repull repairs from head", async () => {
  const f = fixture();
  await f.ops.pull({ ...base(f.dir), sessionId: "s" });
  f.respond((r) => ({
    generation: 1,
    entries: r.beforeSeq === undefined ? [row("1", "10")] : [],
  }));
  const original = Archive.prototype.writeJson;
  Archive.prototype.writeJson = function (rel, data) {
    if (rel.endsWith("state.json")) throw new Error("injected crash");
    return original.call(this, rel, data);
  };
  try {
    assert.equal(
      (await f.ops.pull({ ...base(f.dir), sessionId: "s" })).ok,
      false,
    );
  } finally {
    Archive.prototype.writeJson = original;
  }
  const status = await f.ops.status({ dir: f.dir });
  assert.equal((status.data as any).sessions[0].consistent, false);
  assert.equal((await f.ops.render({ dir: f.dir })).ok, false);
  assert.equal((await f.ops.pull({ ...base(f.dir), sessionId: "s" })).ok, true);
  assert.equal(state(f.dir).recovered_data_state_mismatch, true);
  assert.equal(
    state(f.dir).entries_sha256,
    hash(new Archive(f.dir).read(`${gd()}/entries.jsonl`)!),
  );
});
it("network failure preserves old snapshot and lock releases; no raw secret error leak", async () => {
  const f = fixture();
  await f.ops.pull(base(f.dir));
  const prior = new Archive(f.dir).read(`${gd()}/entries.jsonl`);
  f.respond(() => {
    throw new Error("SECRET-SIGNED-URL");
  });
  const r = await f.ops.pull(base(f.dir));
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes("SECRET"));
  assert.equal(new Archive(f.dir).read(`${gd()}/entries.jsonl`), prior);
  assert.equal(new Archive(f.dir).read(".sync/lock"), undefined);
});
it("time and byte budgets bound pull without false complete", async () => {
  const f = fixture();
  const r = await f.ops.pull({ ...base(f.dir), maxBytes: 100 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(state(f.dir).stop_reason, "byte_budget");
  const g = fixture();
  g.respond(() => new Promise(() => {}));
  const t = Date.now();
  assert.equal(
    (await g.ops.pull({ ...base(g.dir), timeoutMs: 20 })).code,
    "deadline_exceeded",
  );
  assert.ok(Date.now() - t < 1000);
});
it("local status/render do not call client; opaque bodies remain explicit in derived view", async () => {
  const f = fixture();
  await f.ops.pull(base(f.dir));
  const local = new SyncOps({}, "unused");
  assert.equal((await local.status({ dir: f.dir })).ok, true);
  assert.equal((await local.render({ dir: f.dir })).ok, true);
  const md = new Archive(f.dir).read(
    `derived/${component("a")}/${component("s")}/transcript.md`,
  )!;
  assert.ok(md.includes("UNTRUSTED DATA"));
  assert.ok(md.includes("seq 1"));
  assert.ok(md.includes("unsupported/omitted bodies"));
});
it("MCP fixed root + independent local write gates, read-only mode excludes mutators", async () => {
  assert.equal(
    buildTools().some((t) => t.name.startsWith("sync_")),
    false,
  );
  const cfg = {
    root: temp(),
    accountId: "u",
    teamId: "none",
    acknowledgeUnverifiedScope: true,
  };
  assert.deepEqual(
    buildTools({ sync: cfg })
      .filter((t) => t.name.startsWith("sync_"))
      .map((t) => t.name),
    ["sync_status"],
  );
  const full = buildTools({ allowWrites: true, sync: { ...cfg, allowLocalWrites: true } });
  assert.ok(full.some((t) => t.name === "sync_pull"));
  const ro = buildTools({
    readOnly: true,
    sync: { ...cfg, allowLocalWrites: true },
  });
  assert.ok(!ro.some((t) => ["sync_pull", "sync_render"].includes(t.name)));
  assert.equal(
    full
      .find((t) => t.name === "sync_pull")!
      .inputSchema.safeParse({ agent_id: "a", dir: "/arbitrary" }).success,
    false,
  );
  const f = fixture();
  const r = await full
    .find((t) => t.name === "sync_pull")!
    .handler({ sync: f.ops } as any, {
      agent_id: "a",
      dry_run: true,
      dir: "/arbitrary",
    });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync("/arbitrary"), false);
});
it("history compatibility fix recognizes actual protobuf fields", async () => {
  const ops = new MessageOps({
    listGrokBotTranscriptEntries: async () => ({
      generation: 1,
      entries: [row("1", "1", { bodyOmitted: true })],
    }),
  });
  const r = await ops.history({ agentId: "a" });
  assert.equal(r.data!.entries[0].kind, "message");
  assert.equal(r.data!.entries[0].omitted, true);
  assert.equal(r.data!.entries[0].preview, undefined);
});
it("CLI stdout is one JSON envelope; local status needs no credentials; strict flags and pure dryrun", () => {
  const d = path.join(temp(), "new");
  const run = (args: string[]) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli/main.ts", "--json", ...args],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          GBT_ACCESS_TOKEN: "",
          GBT_MOCK: "0",
          GBT_CREDENTIALS_DIR: path.join(temp(), "auth"),
        },
      },
    );
  const r = run([
    "--dry-run",
    "sync",
    "pull",
    "--agent-id",
    "a",
    "--dir",
    d,
    "--account-id",
    "u",
    "--team-id",
    "none",
    "--ack-unverified-scope",
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).code, "dry_run");
  assert.equal(fs.existsSync(d), false);
  const status = run(["sync", "status", "--dir", d]);
  assert.equal(status.status, 5);
  assert.equal(JSON.parse(status.stderr).code, "not_found");
  const bad = run(["sync", "pull", "--dir", d, "--all"]);
  assert.equal(bad.status, 2);
  assert.ok(bad.stderr.includes("usage"));
});

it("real generated Connect transport round trip shared by MCP and CLI core (read RPCs only)", async () => {
  const reqs: any[] = [];
  const transport = createRouterTransport(({ service }) =>
    service(GrokBotService, {
      listGrokBotAgents: async () => ({ agents: [{ id: "a", name: "demo" }] }),
      listGrokBotAgentSessions: async () => ({
        sessions: [{ agentId: "a", sessionId: "s", kind: 1 }],
      }),
      listGrokBotTranscriptEntries: async (req: any) => {
        reqs.push(req);
        return {
          generation: 2,
          entries:
            req.beforeSeq === undefined
              ? [
                  row("9007199254740999", "9007199254741000", {
                    body: new Uint8Array([1, 2, 3]),
                    entryId: "entry-a",
                  }),
                ]
              : [],
        };
      },
    }),
  );
  const p = new ControlPlane({
    baseUrl: "https://example.test",
    transport,
    simulated: true,
  });
  const dir = temp();
  const tool = buildTools({
    allowWrites: true,
    sync: {
      root: dir,
      allowLocalWrites: true,
      accountId: "u",
      teamId: "none",
      acknowledgeUnverifiedScope: true,
    },
  }).find((t) => t.name === "sync_pull")!;
  const r = await tool.handler(p, { agent_id: "a", session_id: "s" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.simulated, true);
  assert.equal(reqs[1].beforeSeq, 9007199254740999n);
  assert.equal(entries(dir, "s", 2)[0].body_base64, "AQID");
});
it("new omitted revision keeps previous body separately with its own version", async () => {
  const f = fixture();
  f.respond((r) => ({
    generation: 1,
    entries:
      r.beforeSeq === undefined
        ? [row("1", "1", { body: new Uint8Array([42]) })]
        : [],
  }));
  await f.ops.pull(base(f.dir));
  f.respond((r) => ({
    generation: 1,
    entries:
      r.beforeSeq === undefined ? [row("1", "2", { bodyOmitted: true })] : [],
  }));
  await f.ops.pull(base(f.dir));
  const e = entries(f.dir)[0];
  assert.equal(e.decode_status, "omitted");
  assert.deepEqual(e.last_available_body, {
    updated_seq: "1",
    body_base64: "Kg==",
  });
});
it("preexisting unsafe nested directory symlink is never followed", async () => {
  const f = fixture(),
    out = temp();
  fs.symlinkSync(out, path.join(f.dir, "bots"));
  assert.equal((await f.ops.pull(base(f.dir))).code, "denied");
  assert.deepEqual(fs.readdirSync(out), []);
});
it("a stale fetched revision cannot overwrite newer local version", async () => {
  const f = fixture();
  f.respond((r) => ({
    generation: 1,
    entries: r.beforeSeq === undefined ? [row("1", "9")] : [],
  }));
  await f.ops.pull(base(f.dir));
  f.respond((r) => ({
    generation: 1,
    entries: r.beforeSeq === undefined ? [row("1", "3")] : [],
  }));
  await f.ops.pull(base(f.dir));
  assert.equal(entries(f.dir)[0].updated_seq, "9");
});

function mockFile() {
  const file = path.join(temp(), "fake-state.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      bots: [{ id: "a", name: "fake" }],
      sessions: [{ agentId: "a", sessionId: "s", kind: 1 }],
      transcript: [
        { seq: "2", updatedSeq: "2", entryKind: "notice", bodyOmitted: true },
      ],
    }),
    { mode: 0o600 },
  );
  return file;
}
it("CLI pull/status/render use actual generated mock transport and bounded JSON stdout", () => {
  const d = temp(),
    file = mockFile();
  const run = (args: string[]) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli/main.ts", "--json", ...args],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GBT_MOCK: "1",
          GBT_MOCK_STATE: file,
          GBT_ALLOW_WRITES: "0",
          GBT_CREDENTIALS_DIR: temp(),
        },
      },
    );
  const r = run([
    "sync",
    "pull",
    "--dir",
    d,
    "--agent-id",
    "a",
    "--session-id",
    "s",
    "--account-id",
    "u",
    "--team-id",
    "none",
    "--ack-unverified-scope",
  ]);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.simulated, true);
  assert.equal(j.data.sessions[0].entries, 1);
  assert.ok(r.stdout.length < 4096);
  assert.ok(!r.stdout.includes("body_base64"));
  assert.equal(run(["sync", "status", "--dir", d]).status, 0);
  assert.equal(run(["sync", "render", "--dir", d]).status, 0);
});
it("MCP stdio advertises gates and executes sync without remote-write permission", async () => {
  const dir = temp(),
    file = mockFile();
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      GBT_MOCK: "1",
      GBT_MOCK_STATE: file,
      GBT_CREDENTIALS_DIR: temp(),
      GBT_SYNC_ROOT: dir,
      GBT_SYNC_ALLOW_LOCAL_WRITES: "1",
      GBT_SYNC_ACCOUNT_ID: "u",
      GBT_SYNC_TEAM_ID: "none",
      GBT_SYNC_ACK_UNVERIFIED_SCOPE: "1",
      GBT_ALLOW_WRITES: "1",
      GBT_MCP_READONLY: "0",
    }).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/main.ts"],
    env,
    stderr: "pipe",
  });
  const c = new Client({ name: "sync-test", version: "1" });
  try {
    await c.connect(transport);
    const tools = await c.listTools();
    assert.ok(tools.tools.some((t) => t.name === "sync_pull"));
    const r = await c.callTool({
      name: "sync_pull",
      arguments: { agent_id: "a", session_id: "s" },
    });
    assert.equal(r.isError, false, JSON.stringify(r));
    assert.equal((r.structuredContent as any).simulated, true);
    assert.equal(entries(dir)[0].body_omitted, true);
  } finally {
    await c.close();
  }
  const ro = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/main.ts"],
    env: { ...env, GBT_MCP_READONLY: "1" },
    stderr: "pipe",
  });
  const c2 = new Client({ name: "sync-test", version: "1" });
  try {
    await c2.connect(ro);
    const ts = await c2.listTools();
    assert.ok(ts.tools.some((t) => t.name === "sync_status"));
    assert.ok(
      !ts.tools.some((t) => ["sync_pull", "sync_render"].includes(t.name)),
    );
  } finally {
    await c2.close();
  }
});

it("untrusted writable ancestor and hardlinked files are refused", async () => {
  const parent = temp(),
    root = path.join(parent, "root");
  fs.mkdirSync(root, { mode: 0o700 });
  fs.chmodSync(parent, 0o777);
  try {
    assert.equal(
      (await new SyncOps({}, "https://example.test").status({ dir: root }))
        .code,
      "denied",
    );
  } finally {
    fs.chmodSync(parent, 0o700);
  }
  const f = fixture();
  await f.ops.pull(base(f.dir));
  fs.linkSync(path.join(f.dir, "manifest.json"), path.join(temp(), "linked"));
  assert.equal((await f.ops.status({ dir: f.dir })).code, "denied");
});
it("known remote read error codes stay machine-readable without raw error strings", async () => {
  const f = fixture();
  f.respond(() => {
    throw { code: 7, message: "PRIVATE" };
  });
  const r = await f.ops.pull(base(f.dir));
  assert.equal(r.code, "permission_denied");
  assert.ok(!JSON.stringify(r).includes("PRIVATE"));
});
it("raw wire preserves unknown fields without guessing their semantics", () => {
  const original = row("2").toBinary(),
    wire = new Uint8Array([...original, 0xa0, 0x06, 0x01]);
  const record = entryRecord(
    GrokBotTranscriptEntry.fromBinary(wire),
    "a",
    "s",
    1,
  );
  assert.deepEqual(
    Buffer.from(record.wire_base64!, "base64"),
    Buffer.from(wire),
  );
});
it("agent-wide pull includes the unlisted default session (empty session_id) under sessions/default", async () => {
  const f = fixture(temp(), []);
  f.respond((r) => ({
    generation: 0,
    entries: r.beforeSeq === undefined && r.sessionId === "" ? [row("1")] : [],
  }));
  const r = await f.ops.pull(base(f.dir));
  assert.equal(r.ok, true);
  const text = new Archive(f.dir).read(
    `bots/${component("a")}/sessions/default/generations/0/entries.jsonl`,
  );
  assert.ok(text && text.includes('"seq":"1"'));
  const explicit = fixture();
  await explicit.ops.pull({ ...base(explicit.dir), sessionId: "s" });
  assert.equal(
    explicit.calls.some((x) => typeof x !== "string" && x.sessionId === ""),
    false,
  );
});
it("budget-one pulls continue historical backfill rather than repeating head forever; generation zero omitted", async () => {
  const f = fixture(temp(), []),
    seen: any[] = [];
  f.respond((r) => {
    seen.push(r);
    const top = r.beforeSeq === undefined ? 7 : Number(r.beforeSeq) - 1;
    return { generation: 0, entries: top > 0 ? [row(String(top))] : [] };
  });
  for (let n = 0; n < 16; n++)
    assert.equal(
      (await f.ops.pull({ ...base(f.dir), pageSize: 1, maxPages: 1 })).ok,
      true,
    );
  const a = new Archive(f.dir),
    gd0 = `bots/${component("a")}/sessions/default/generations/0`;
  const rows = a
    .read(gd0 + "/entries.jsonl")!
    .trim()
    .split("\n")
    .map((x) => JSON.parse(x));
  assert.deepEqual(
    rows.map((e) => e.seq),
    ["1", "2", "3", "4", "5", "6", "7"],
  );
  assert.equal(a.json(gd0 + "/state.json").backfill_end_observed, true);
  assert.equal(a.json(gd0 + "/state.json").completeness, "unknown");
  assert.ok(seen.some((r) => r.beforeSeq === 6n));
  assert.ok(seen.every((r) => r.generation === undefined));
});
it("global one-page budget rotates across named and default sessions", async () => {
  const f = fixture(temp(), ["s", "z"]);
  const seen = new Set<string>();
  f.respond((r) => {
    seen.add(r.sessionId);
    return { generation: 1, entries: [row("10")] };
  });
  for (let n = 0; n < 3; n++)
    assert.equal((await f.ops.pull({ ...base(f.dir), maxPages: 1 })).ok, true);
  assert.deepEqual([...seen].sort(), ["", "s", "z"]);
});
it("crash does not trust unpublished backfill cursor; restored pull still progresses", async () => {
  const f = fixture(temp(), []);
  f.respond((r) => ({
    generation: 1,
    entries:
      r.beforeSeq === undefined
        ? [row("5")]
        : Number(r.beforeSeq) > 1
          ? [row(String(Number(r.beforeSeq) - 1))]
          : [],
  }));
  await f.ops.pull({ ...base(f.dir), maxPages: 1, pageSize: 1 });
  const rel = `bots/${component("a")}/sessions/default/generations/1/state.json`,
    a = new Archive(f.dir),
    state = a.json(rel);
  a.writeJson(rel, {
    ...state,
    backfill_before_seq: "1",
    entries_sha256: "bad",
  });
  await f.ops.pull({ ...base(f.dir), maxPages: 2, pageSize: 1 });
  assert.equal(a.json(rel).recovered_data_state_mismatch, true);
  assert.equal(a.json(rel).backfill_before_seq, "4");
});
it("CLI message send dryrun uses default session without reading credentials", () => {
  const r = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/cli/main.ts",
      "--json",
      "--dry-run",
      "message",
      "send",
      "--agent-id",
      "test-only",
      "--text",
      "fixed-test",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, GBT_CREDENTIALS_DIR: "/absent/credentials" },
    },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).data.session_id, "");
});
it("rejected oversized head response does not claim head refresh", async () => {
  const f = fixture(temp(), []);
  f.respond(() => ({
    generation: 0,
    entries: [row("1", "1", { body: Buffer.alloc(10000) })],
  }));
  await f.ops.pull({ ...base(f.dir), maxBytes: 1000, maxPages: 1 });
  const st = new Archive(f.dir).json(
    `bots/${component("a")}/sessions/default/generations/0/state.json`,
  );
  assert.equal(st.head_refreshed_at_ms, null);
  assert.equal(st.next_phase, "head");
});
