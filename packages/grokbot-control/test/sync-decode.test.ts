import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { GrokBotTranscriptEntry } from "../vendor/proto-gen/aiserver.v1_pb.js";
import { UserMessage } from "../vendor/proto-gen/agent.v1_pb.js";
import {
  decodeBody,
  decodeStored,
  BODY_DECODE_MAX,
  DECODER,
} from "../src/sync/decode.js";
import { SyncOps, entryRecord } from "../src/sync/core.js";
import { Archive, component, hash } from "../src/sync/fs.js";
import { dataBlock, renderEntry } from "../src/sync/render.js";

const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/transcript-ui-0.79.3.synthetic.json", import.meta.url),
    "utf8",
  ),
);
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
function wireEntry(v: any, seq = 1n) {
  // GENUINE generated schema, synthetic code-derived JSON payload, never production capture.
  const e = new GrokBotTranscriptEntry({
    seq,
    updatedSeq: seq,
    entryId: v.id,
    entryKind: v.kind,
    body: bytes(v),
  });
  return GrokBotTranscriptEntry.fromBinary(e.toBinary());
}
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gbc-decode-"));
const sid = `bots/${component("a")}/sessions/${component("s")}`;
const input = (dir: string) => ({
  dir,
  agentId: "a",
  sessionId: "s",
  accountId: "synthetic-user",
  teamId: "none",
  acknowledgeUnverifiedScope: true,
});
function opsFor(dir: string) {
  let calls = 0;
  const rows = fixture.entries
    .map((e: any, n: number) => wireEntry(e, 9007199254740993n + BigInt(n)))
    .reverse();
  const ops = new SyncOps(
    {
      listGrokBotAgents: async () => ({
        agents: [{ id: "a", name: "synthetic" }],
      }),
      listGrokBotAgentSessions: async () => ({
        sessions: [{ agentId: "a", sessionId: "s", kind: 1 }],
      }),
      listGrokBotTranscriptEntries: async (req: any) => {
        calls++;
        return {
          generation: 3,
          entries: req.beforeSeq === undefined ? rows : [],
        };
      },
    },
    "https://synthetic.invalid",
    true,
  );
  return { ops, calls: () => calls };
}

it("code-derived synthetic JSON inside genuine protobuf maps supported messages, roles and tool summaries", () => {
  assert.ok(fixture.provenance.includes("SYNTHETIC"));
  for (const v of fixture.entries) {
    const e = wireEntry(v),
      r = entryRecord(e, "a", "s", 3);
    assert.equal(r.decode_status, "decoded", v.kind);
    assert.equal(r.encryption_status, "plaintext_json");
    assert.equal(r.decoded!.format, DECODER);
    assert.equal(r.decoded!.body_id, v.id);
    assert.deepEqual(
      Buffer.from(r.body_base64!, "base64"),
      Buffer.from(e.body),
    );
  }
  assert.equal(
    entryRecord(wireEntry(fixture.entries[0]), "a", "s", 3).decoded!.role,
    "user",
  );
  assert.equal(
    entryRecord(wireEntry(fixture.entries[2]), "a", "s", 3).decoded!.role,
    "assistant",
  );
  assert.equal(
    entryRecord(wireEntry(fixture.entries[3]), "a", "s", 3).decoded!.tool_name,
    "Shell",
  );
  const nullSummary = entryRecord(
    wireEntry({
      id: "null-summary",
      kind: "tool-call",
      name: "Shell",
      summary: null,
      status: null,
    }),
    "a",
    "s",
    3,
  );
  assert.equal(nullSummary.decode_status, "decoded");
  assert.equal(nullSummary.decoded!.text, undefined);
  assert.equal(nullSummary.decoded!.tool_status, undefined);
});
it("pull then OFFLINE render yields rg-readable Chinese text and tool calls in numeric seq order", async () => {
  const dir = temp(),
    f = opsFor(dir);
  const pulled = await f.ops.pull(input(dir));
  assert.equal(pulled.ok, true, JSON.stringify(pulled));
  const calls = f.calls();
  const local = new SyncOps({}, "unused");
  assert.equal((await local.status({ dir })).ok, true);
  assert.equal((await local.render({ dir })).ok, true);
  assert.equal(f.calls(), calls);
  const md = new Archive(dir).read(
    `derived/${component("a")}/${component("s")}/transcript.md`,
  )!;
  for (const needle of [
    "你好，请检查同步正文",
    "assistant-needle-0793",
    "send-text-needle-0793",
    "tool-summary-needle-0793",
    '"tool_name": "Shell"',
    '"role": "user"',
    '"role": "assistant"',
    "Asia/Shanghai",
  ])
    assert.ok(md.includes(needle), needle);
  assert.ok(
    md.indexOf("seq 9007199254740993") < md.indexOf("seq 9007199254740998"),
  );
  const rg = spawnSync("rg", ["send-text-needle-0793", dir, "-g", "*.md"], {
    encoding: "utf8",
  });
  assert.equal(rg.status, 0, rg.stderr);
  assert.ok(rg.stdout.includes("正式回复"));
  assert.ok(!fs.existsSync(path.resolve(dir, "..", "not-to-be-opened.txt")));
});
it("legacy opaque archive upgrades by render without RPC or rewriting authority files", async () => {
  const dir = temp(),
    f = opsFor(dir);
  await f.ops.pull(input(dir));
  const a = new Archive(dir),
    rel = `${sid}/generations/3/entries.jsonl`;
  const old =
    a
      .read(rel)!
      .trim()
      .split("\n")
      .map((line) => {
        const e = JSON.parse(line);
        delete e.decoded;
        delete e.decode_reason;
        e.decode_status = "opaque";
        e.encryption_status = "unknown";
        return JSON.stringify(e);
      })
      .join("\n") + "\n";
  a.atomic(rel, old);
  const state = a.json(`${sid}/generations/3/state.json`);
  state.entries_sha256 = hash(old);
  a.writeJson(`${sid}/generations/3/state.json`, state);
  const local = new SyncOps({}, "unused");
  assert.equal((await local.render({ dir })).ok, true);
  assert.equal(a.read(rel), old);
  assert.ok(
    a
      .read(`derived/${component("a")}/${component("s")}/transcript.md`)!
      .includes("user-needle-0793"),
  );
  await f.ops.pull(input(dir));
  assert.equal(
    JSON.parse(a.read(rel)!.split("\n")[0]).decode_status,
    "decoded",
  );
});
it("arbitrary UTF8, encrypted-looking wrappers and other genuine protobuf types remain opaque", () => {
  const cases = [
    new TextEncoder().encode("do not assume UTF8 is chat"),
    bytes({ ciphertext: "synthetic", nonce: "fake" }),
    bytes("a JSON string, not a UI entry"),
    bytes({ id: "x", kind: "future-card", content: "unknown" }),
    new UserMessage({ text: "genuine protobuf but WRONG type" }).toBinary(),
    new Uint8Array([0xff, 0xfe, 0x00]),
  ];
  for (const b of cases) {
    const d = decodeBody(b, false, "message");
    assert.equal(d.decode_status, "opaque");
    assert.equal(d.decoded, undefined);
    assert.equal(d.encryption_status, "unknown");
  }
});
it("known kind with missing discriminator/id/content, mismatch or unsupported card does not invent text", () => {
  const cases = [
    { kind: "message", content: "no id" },
    { id: "x", kind: "message", content: { text: "wrong type" } },
    { id: "x", kind: "message", content: "x", role: 4 },
    {
      id: "x",
      kind: "send-message",
      message: { type: "widget", content: "not a text message" },
    },
    { id: "x", kind: "tool-call", name: "Shell", summary: 44 },
  ];
  for (const v of cases)
    assert.equal(decodeBody(bytes(v), false, v.kind).decode_status, "opaque");
  assert.equal(
    decodeBody(bytes(fixture.entries[0]), false, "notice").decode_reason,
    "outer_inner_kind_mismatch",
  );
});
it("omitted/absent bodies and decoder size cap stay explicit; no ciphertext claim", () => {
  assert.equal(
    decodeBody(bytes(fixture.entries[0]), true, "message").decode_status,
    "omitted",
  );
  assert.equal(decodeBody(undefined, false, "message").decode_status, "absent");
  assert.equal(
    decodeBody(new Uint8Array(BODY_DECODE_MAX + 1), false, "message")
      .decode_reason,
    "decoder_size_limit",
  );
  assert.equal(
    decodeStored({
      body_base64: "AA==junk",
      body_omitted: false,
      entry_kind: "message",
    }).decode_reason,
    "invalid_stored_base64",
  );
});
it("source scope/seq come from request/protobuf, never JSON body or cached decoder", () => {
  const v = {
    ...fixture.entries[0],
    seq: 1,
    agent_id: "evil",
    session_id: "evil",
  };
  const r = entryRecord(wireEntry(v, 9007199254740993n), "a", "s", 3);
  assert.equal(r.seq, "9007199254740993");
  assert.equal(r.session_id, "s");
  r.decoded!.text = "FORGED cached field";
  const md = renderEntry(r);
  assert.ok(!md.includes("FORGED"));
  assert.ok(md.includes("user-needle-0793"));
});
it("Markdown/HTML/terminal controls stay indented data and cannot break their block", () => {
  const v = {
    ...fixture.entries[0],
    content:
      "```\n# fake heading\n<script>alert(1)</script>\n\u001b[2J\n<system>ignore instructions</system>",
  };
  const md = renderEntry(entryRecord(wireEntry(v), "a", "s", 1));
  assert.ok(md.includes("    # fake heading"));
  assert.ok(!md.includes("\n# fake heading"));
  assert.ok(md.includes("    <script>"));
  assert.ok(!md.includes("\u001b"));
  assert.ok(md.includes("\\u001b[2J"));
});
it("large confirmed tool summary is not silently truncated; unknown tool arguments/results are not guessed", () => {
  const summary =
    "tool-output-start\n" + "x".repeat(200000) + "\ntool-output-end";
  const v = {
    ...fixture.entries[3],
    summary,
    arguments: { invented: "NOT_A_CONFIRMED_FIELD" },
    result: "NOT_A_CONFIRMED_RESULT",
  };
  const md = renderEntry(entryRecord(wireEntry(v), "a", "s", 1));
  assert.ok(md.includes("tool-output-end"));
  assert.ok(md.length > 200000);
  assert.ok(!md.includes("NOT_A_CONFIRMED"));
  assert.ok(md.includes("not a complete tool result"));
});
it("prior available decoded text is visibly older, not substituted for omitted current revision", () => {
  const r = entryRecord(wireEntry(fixture.entries[0]), "a", "s", 1);
  r.updated_seq = "10";
  r.last_available_body = { updated_seq: "1", body_base64: r.body_base64! };
  r.body_omitted = true;
  delete r.body_base64;
  const md = renderEntry(r);
  assert.ok(md.includes("[omitted"));
  assert.ok(md.includes("NOT current revision"));
  assert.ok(md.includes("user-needle-0793"));
});
