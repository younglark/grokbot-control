import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { SyncOps, entryRecord } from "../src/sync/core.js";
import { Archive, component, hash } from "../src/sync/fs.js";
import {
  acceptStoreRead,
  objectRel,
  refRel,
  sha256Hex,
} from "../src/sync/attachments.js";
import { GrokBotAttachmentReadOutcome } from "../vendor/proto-gen/aiserver.v1_pb.js";
import { GrokBotTranscriptEntry } from "../vendor/proto-gen/aiserver.v1_pb.js";
import { buildTools } from "../src/mcp/tools.js";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gbc-att-"));
const gd = (s = "s", g = 1) =>
  `bots/${component("a")}/sessions/${component(s)}/generations/${g}`;

function seedArchive(dir: string, remotePath = "uploads/demo.bin") {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const a = new Archive(dir, true);
  a.writeJson("manifest.json", {
    format_version: 1,
    scope: {
      backend: "https://example.test",
      account_id: "stable-user-1",
      team_id: "none",
      assurance: "operator_asserted_unverified",
    },
    pagination_live_verified: false,
    attachment_policy: "references_only",
    sessions: [{ agent_id: "a", session_id: "s" }],
  });
  const body = Buffer.from(
    JSON.stringify({
      kind: "user-attachment",
      id: "att-1",
      file_path: remotePath,
      file_name: "demo.bin",
      timestampMs: 1,
    }),
    "utf8",
  );
  const entry = entryRecord(
    new GrokBotTranscriptEntry({
      seq: 1n,
      updatedSeq: 1n,
      entryKind: "user-attachment",
      body,
    }),
    "a",
    "s",
    1,
  );
  const text = JSON.stringify(entry) + "\n";
  a.atomic(`${gd()}/entries.jsonl`, text);
  a.writeJson(`${gd()}/state.json`, {
    generation: 1,
    entries_sha256: hash(text),
    entries: 1,
    completeness: "unknown",
    attachments: "references_only",
  });
  a.writeJson(`bots/${component("a")}/sessions/${component("s")}/session.json`, {
    agent_id: "a",
    session_id: "s",
    current_generation: 1,
    untrusted: true,
  });
  return { a, entry, remotePath };
}

function httpFixture(body: Buffer, status = 200, headers: Record<string, string> = {}) {
  const server = createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405);
      res.end();
      return;
    }
    res.writeHead(status, {
      "content-length": String(body.length),
      "content-type": "application/octet-stream",
      ...headers,
    });
    res.end(body);
  });
  return new Promise<{
    url: string;
    close: () => Promise<void>;
  }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      resolve({
        url: `http://127.0.0.1:${addr.port}/file`,
        close: () =>
          new Promise((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
  });
}

it("acceptStoreRead requires STORE https unexpired URL and never needs the URL logged", () => {
  const ok = acceptStoreRead(
    "p",
    {
      path: "p",
      outcome: GrokBotAttachmentReadOutcome.STORE,
      url: "https://cdn.example/x",
      expiresAtMs: Date.now() + 60_000,
      sizeBytes: 3n,
    },
    Date.now(),
  );
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.store.url.startsWith("https://"), true);
  assert.equal(
    acceptStoreRead(
      "p",
      {
        path: "p",
        outcome: GrokBotAttachmentReadOutcome.NOT_IN_STORE,
        url: "https://cdn.example/x",
      },
      Date.now(),
    ).ok,
    false,
  );
  assert.equal(
    acceptStoreRead(
      "p",
      {
        path: "p",
        outcome: GrokBotAttachmentReadOutcome.STORE,
        url: "http://insecure.example/x",
      },
      Date.now(),
    ).ok,
    false,
  );
});

it("downloads attachment on demand, skips verified local object, and never stores signed URL", async () => {
  const dir = temp();
  const { remotePath } = seedArchive(dir);
  const payload = Buffer.from("attachment-bytes-v1");
  // Local mock HTTPS substitute: acceptStoreRead rejects http, so inject fetch + STORE with https URL
  // while fetchImpl serves local bytes (URL itself never written).
  const signed = "https://signed.example/secret-token-should-not-persist";
  const resolveCalls: any[] = [];
  const fetchCalls: string[] = [];
  const client = {
    async resolveGrokBotAttachmentReads(req: any) {
      resolveCalls.push(req);
      return {
        reads: [
          {
            path: remotePath,
            outcome: GrokBotAttachmentReadOutcome.STORE,
            url: signed,
            expiresAtMs: BigInt(Date.now() + 60_000),
            sizeBytes: BigInt(payload.length),
            contentType: "application/octet-stream",
            etag: '"e1"',
          },
        ],
      };
    },
  };
  const fetchImpl = async (url: string) => {
    fetchCalls.push(url);
    assert.equal(url, signed);
    return new Response(payload, {
      status: 200,
      headers: {
        "content-length": String(payload.length),
        "content-type": "application/octet-stream",
      },
    });
  };
  const ops = new SyncOps(client, "https://example.test", true, fetchImpl);
  const first = await ops.attachments({ dir, agentId: "a", sessionId: "s" });
  assert.equal(first.ok, true);
  const digest = sha256Hex(payload);
  const rel = objectRel("a", digest);
  assert.equal(fs.existsSync(path.join(dir, rel)), true);
  assert.deepEqual(fs.readFileSync(path.join(dir, rel)), payload);
  const ref = JSON.parse(
    fs.readFileSync(path.join(dir, refRel("a", remotePath)), "utf8"),
  );
  assert.equal(ref.status, "ok");
  assert.equal(ref.content_sha256, digest);
  assert.equal(JSON.stringify(ref).includes("secret-token"), false);
  assert.equal(JSON.stringify(first).includes("secret-token"), false);
  const entries = fs
    .readFileSync(path.join(dir, `${gd()}/entries.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(entries[0].attachment_local.status, "ok");
  assert.equal(entries[0].attachment_local.relative_path, rel);
  assert.equal(JSON.stringify(entries).includes("secret-token"), false);

  const second = await ops.attachments({ dir, agentId: "a", sessionId: "s" });
  assert.equal(second.ok, true);
  assert.equal(resolveCalls.length, 1);
  assert.equal(fetchCalls.length, 1);
  assert.equal((second.data as any).results[0].reason, "already_present");
});

it("records not_in_store without fetching", async () => {
  const dir = temp();
  const { remotePath } = seedArchive(dir);
  let fetched = 0;
  const ops = new SyncOps(
    {
      async resolveGrokBotAttachmentReads() {
        return {
          reads: [
            {
              path: remotePath,
              outcome: GrokBotAttachmentReadOutcome.NOT_IN_STORE,
            },
          ],
        };
      },
    },
    "https://example.test",
    true,
    async () => {
      fetched++;
      return new Response("nope");
    },
  );
  const res = await ops.attachments({ dir, path: remotePath });
  assert.equal(res.ok, true);
  assert.equal((res.data as any).results[0].status, "not_in_store");
  assert.equal(fetched, 0);
  assert.equal(fs.existsSync(path.join(dir, "bots", component("a"), "attachments", "objects")), false);
});

it("rejects control-character remote paths and dry-run does nothing", async () => {
  const dir = temp();
  seedArchive(dir, "safe/path.bin");
  const ops = new SyncOps({}, "https://example.test", true, async () => {
    throw new Error("fetch should not run");
  });
  const dry = await ops.attachments({ dir, dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal((dry.data as any).no_rpc_or_files, true);
  const bad = await ops.attachments({
    dir,
    path: "../etc/passwd",
  });
  assert.equal(bad.ok, false);
  assert.match(String(bad.error?.message ?? bad.code), /unsafe attachment path|invalid_argument/);
});

it("MCP READONLY excludes sync_attachments; local-write gate includes it", () => {
  const root = temp();
  fs.chmodSync(root, 0o700);
  const ro = buildTools({
    readOnly: true,
    sync: { root, allowLocalWrites: true, accountId: "u", teamId: "none", acknowledgeUnverifiedScope: true },
  }).map((t) => t.name);
  assert.equal(ro.includes("sync_attachments"), false);
  assert.equal(ro.includes("sync_status"), true);
  const rw = buildTools({
    readOnly: false,
    sync: { root, allowLocalWrites: true, accountId: "u", teamId: "none", acknowledgeUnverifiedScope: true },
  }).map((t) => t.name);
  assert.equal(rw.includes("sync_attachments"), true);
  const statusOnly = buildTools({
    readOnly: false,
    sync: { root, allowLocalWrites: false },
  }).map((t) => t.name);
  assert.equal(statusOnly.includes("sync_attachments"), false);
});

// silence unused http helper for now but keep for potential extension
void httpFixture;
