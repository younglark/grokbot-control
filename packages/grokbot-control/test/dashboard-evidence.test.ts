import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compareUint64,
  decideSourceVersion,
  formatSourceVersion,
  sourceVersionFromUpdatedSeq,
  uint64ToString,
} from "../src/localdash/uint64.js";
import { sanitizeAwaiting } from "../src/localdash/awaiting.js";
import { aggregateDemands, shouldDropDemand, transcriptDemandKey } from "../src/localdash/demand.js";
import {
  EvidenceStore,
  activityEntityKey,
  accountScope,
} from "../src/localdash/evidence.js";
import { mapTimelineEntry } from "../src/ops/transcript-map.js";
import { mapStatus } from "../src/ops/map.js";

describe("uint64 source versions", () => {
  it("compares values beyond MAX_SAFE_INTEGER without using Number", () => {
    const a = "9007199254740993"; // beyond Number.MAX_SAFE_INTEGER
    const b = "9007199254740994";
    assert.equal(compareUint64(a, b), -1);
    assert.equal(compareUint64(b, a), 1);
    assert.equal(compareUint64(a, a), 0);
    assert.equal(uint64ToString(9007199254740993), undefined);
    assert.equal(uint64ToString(9007199254740993n), "9007199254740993");
    assert.equal(uint64ToString("0900"), "900");
  });

  it("does not treat local revisions as source versions and unknown never overrides known", () => {
    const known = sourceVersionFromUpdatedSeq("12");
    const unknown = sourceVersionFromUpdatedSeq(undefined);
    assert.equal(formatSourceVersion(unknown), "unknown");
    assert.equal(decideSourceVersion(known, unknown), "keep_existing_known");
    assert.equal(decideSourceVersion(unknown, known), "apply");
    assert.equal(decideSourceVersion(known, sourceVersionFromUpdatedSeq("11")), "reject_older");
    assert.equal(decideSourceVersion(known, sourceVersionFromUpdatedSeq("12")), "idempotent");
    assert.equal(decideSourceVersion(known, sourceVersionFromUpdatedSeq("13")), "apply");
  });
});

describe("awaiting sanitizer", () => {
  it("whitelists a short reason and never returns the raw object or secrets", () => {
    assert.deepEqual(sanitizeAwaiting({ reason: "需要确认", token: "SECRET" }), { observed: true, reason: "需要确认" });
    assert.equal(sanitizeAwaiting({ reason: "Bearer abc" })?.reason, undefined);
    assert.equal(sanitizeAwaiting({ reason: "Bearer abc" })?.reason_unknown, true);
    assert.equal("token" in (sanitizeAwaiting({ reason: "等待", token: "x" }) as object), false);
    assert.equal(sanitizeAwaiting("  排队中  ")?.reason, "排队中");
    const status = mapStatus({
      agentId: "a",
      isRunning: false,
      live: { awaiting: { reason: "等待人类", password: "nope" } },
    });
    assert.deepEqual(status.live?.awaiting, { observed: true, reason: "等待人类" });
  });
});

describe("demand aggregation and epoch drop", () => {
  it("unions graph and timeline consumers per agent/session and isolates clients", () => {
    const agg = aggregateDemands([
      { client_id: "c1", connection_epoch: "e1", agent_id: "agent-1", view_session_id: "s1", graph_visible: true, timeline_visible: false },
      { client_id: "c2", connection_epoch: "e2", agent_id: "agent-1", view_session_id: "s2", graph_visible: false, timeline_visible: true },
      { client_id: "c3", connection_epoch: "e3", agent_id: "agent-2", view_session_id: "s1", graph_visible: false, timeline_visible: false },
    ]);
    assert.deepEqual(agg.detailAgents.sort(), ["agent-1", "agent-2"]);
    assert.equal(agg.transcript.get(transcriptDemandKey("agent-1", "s1"))?.poll, true);
    assert.equal(agg.transcript.get(transcriptDemandKey("agent-1", "s2"))?.poll, true);
    assert.equal(agg.transcript.get(transcriptDemandKey("agent-2", "s1"))?.poll, false);
    assert.equal(shouldDropDemand({ connection_epoch: "new" }, "old"), false);
    assert.equal(shouldDropDemand({ connection_epoch: "old" }, "old"), true);
  });
});

describe("evidence store A contracts", () => {
  const account = accountScope();

  it("keeps a newer updated_seq, rejects older, and does not invent a source version", () => {
    const store = new EvidenceStore({ maxEntities: 50, maxActivityVersions: 50, maxSerializedBytes: 1_000_000 });
    const page = (updated?: string) => [
      mapTimelineEntry({ entryId: "e1", seq: 1n, updatedSeq: updated, entryKind: "notice", body: Buffer.from(JSON.stringify({ id: "e1", kind: "notice", text: "hi", timestampMs: 1 })) }),
    ];
    store.ingestTranscript({ account, agent_id: "a1", session_id: "s1", generation: 3, generation_known: true, entries: page("5"), ok: true, at: 10 });
    const key = activityEntityKey(account, "a1", "s1", 3, true, "1");
    assert.equal(store.getEntity(key)?.source_version, "5");
    store.ingestTranscript({ account, agent_id: "a1", session_id: "s1", generation: 3, generation_known: true, entries: page("4"), ok: true, at: 11 });
    assert.equal(store.getEntity(key)?.source_version, "5");
    store.ingestTranscript({ account, agent_id: "a1", session_id: "s1", generation: 3, generation_known: true, entries: page(undefined), ok: true, at: 12 });
    assert.equal(store.getEntity(key)?.source_version, "5");
    store.ingestTranscript({ account, agent_id: "a1", session_id: "s1", generation: 3, generation_known: true, entries: page("9007199254740994"), ok: true, at: 13 });
    assert.equal(store.getEntity(key)?.source_version, "9007199254740994");
  });

  it("uses (scope, generation, seq) as the stable key and treats entry_id as an index", () => {
    const store = new EvidenceStore();
    store.ingestTranscript({
      account, agent_id: "a1", session_id: "s1", generation: 1, generation_known: true, ok: true, at: 1,
      entries: [mapTimelineEntry({ seq: 9n, updatedSeq: 1n, entryKind: "notice", body: Buffer.from(JSON.stringify({ id: "body", kind: "notice", text: "n", timestampMs: 1 })) })],
    });
    const key = activityEntityKey(account, "a1", "s1", 1, true, "9");
    assert.equal(store.getEntity(key)?.entry_id, undefined);
    store.ingestTranscript({
      account, agent_id: "a1", session_id: "s1", generation: 1, generation_known: true, ok: true, at: 2,
      entries: [mapTimelineEntry({ entryId: "E9", seq: 9n, updatedSeq: 2n, entryKind: "notice", body: Buffer.from(JSON.stringify({ id: "body", kind: "notice", text: "n", timestampMs: 1 })) })],
    });
    assert.equal(store.getEntity(key)?.entry_id, "E9");
    assert.equal(store.getEntity(key)?.source_version, "2");
  });

  it("does not mix the same seq or entry_id across session or generation", () => {
    const store = new EvidenceStore();
    const entry = (id: string) => mapTimelineEntry({ entryId: id, seq: 1n, updatedSeq: 1n, entryKind: "notice", body: Buffer.from(JSON.stringify({ id, kind: "notice", text: "n", timestampMs: 1 })) });
    store.ingestTranscript({ account, agent_id: "a1", session_id: "s1", generation: 1, generation_known: true, entries: [entry("same")], ok: true, at: 1 });
    store.ingestTranscript({ account, agent_id: "a1", session_id: "s2", generation: 1, generation_known: true, entries: [entry("same")], ok: true, at: 1 });
    store.ingestTranscript({ account, agent_id: "a1", session_id: "s1", generation: 2, generation_known: true, entries: [entry("same")], ok: true, at: 1 });
    const ev = store.buildEvidence({ account, agent_id: "a1", session_ids: ["s1", "s2"] });
    const activities = ev.entities.filter((e) => e.kind === "activity");
    assert.equal(activities.length, 3);
  });

  it("marks snapshot disappearance and window roll-off without inventing success or deletion", () => {
    const store = new EvidenceStore();
    store.ingestTasks({ account, agent_id: "a1", ok: true, at: 1, tasks: [{ id: "t1", name: "T", status: "running" }] });
    store.ingestSubagents({ account, agent_id: "a1", ok: true, at: 1, subagents: [{ subagent_id: "sub", title: "S" }] });
    store.ingestTasks({ account, agent_id: "a1", ok: true, at: 2, tasks: [] });
    store.ingestSubagents({ account, agent_id: "a1", ok: true, at: 2, subagents: [] });
    const ev = store.buildEvidence({ account, agent_id: "a1" });
    const task = ev.entities.find((e) => e.kind === "task");
    const sub = ev.entities.find((e) => e.kind === "subagent");
    assert.equal(task?.presence, "not_in_snapshot");
    assert.equal(task?.view_status, "unknown");
    assert.equal(sub?.presence, "not_in_snapshot");
    assert.ok(ev.gaps.some((g) => g.detail.includes("本次未观测到")));

    const pages = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) =>
        mapTimelineEntry({
          entryId: `e${from + i}`,
          seq: BigInt(from + i),
          updatedSeq: 1n,
          entryKind: "notice",
          body: Buffer.from(JSON.stringify({ id: `e${from + i}`, kind: "notice", text: "n", timestampMs: 1 })),
        }),
      );
    store.ingestTranscript({ account, agent_id: "a1", session_id: "s1", generation: 1, generation_known: true, entries: pages(1, 200), ok: true, at: 3 });
    store.ingestTranscript({ account, agent_id: "a1", session_id: "s1", generation: 1, generation_known: true, entries: pages(2, 201), ok: true, at: 4 });
    const after = store.buildEvidence({ account, agent_id: "a1", session_ids: ["s1"] });
    const first = after.entities.find((e) => e.seq === "1");
    const last = after.entities.find((e) => e.seq === "201");
    assert.equal(first?.presence, "outside_window");
    assert.equal(last?.presence, "in_snapshot");
    assert.equal(after.entities.filter((e) => e.kind === "activity").length, 201);
    assert.ok(after.gaps.some((g) => g.detail.includes("不在当前返回窗口")));
    assert.equal(after.history_completeness, "unknown");
    assert.ok(after.notes.some((n) => /不证明历史完整/.test(n)));
  });

  it("does not refresh lastSuccessfulObservedAt on failure or pause", () => {
    const store = new EvidenceStore();
    store.ingestTasks({ account, agent_id: "a1", ok: true, at: 100, tasks: [{ id: "t1" }] });
    store.ingestTasks({ account, agent_id: "a1", ok: false, at: 200, error: "boom", tasks: undefined });
    assert.equal(store.observation("a1", "tasks").last_successful_observed_at_ms, 100);
    assert.equal(store.observation("a1", "tasks").result, "error");
    store.recordObservation("a1", store.observation("a1", "transcript"));
    store.ingestTranscript({ account, agent_id: "a1", session_id: "s1", generation: 1, generation_known: true, entries: [], ok: true, at: 150 });
    store.ingestTranscript({ account, agent_id: "a1", session_id: "s1", generation: 1, generation_known: true, entries: [], ok: false, paused: true, at: 300 });
    assert.equal(store.observation("a1", "transcript").last_successful_observed_at_ms, 150);
    assert.equal(store.observation("a1", "transcript").result, "paused");
    assert.equal(store.observation("a1", "tasks").source_freshness, "unknown");
  });

  it("leaves last_message_entry_id unresolved without a confirmed scope and does not cross sessions", () => {
    const store = new EvidenceStore();
    store.ingestTranscript({
      account, agent_id: "a1", session_id: "s1", generation: 1, generation_known: true, ok: true, at: 1,
      entries: [mapTimelineEntry({ entryId: "shared", seq: 1n, updatedSeq: 1n, entryKind: "notice", body: Buffer.from(JSON.stringify({ id: "shared", kind: "notice", text: "n", timestampMs: 1 })) })],
    });
    store.ingestTranscript({
      account, agent_id: "a1", session_id: "s2", generation: 1, generation_known: true, ok: true, at: 1,
      entries: [mapTimelineEntry({ entryId: "shared", seq: 1n, updatedSeq: 1n, entryKind: "notice", body: Buffer.from(JSON.stringify({ id: "shared", kind: "notice", text: "n", timestampMs: 1 })) })],
    });
    store.ingestTasks({ account, agent_id: "a1", ok: true, at: 2, tasks: [{ id: "t1", last_message_entry_id: "shared", subagent_ids: ["sub"] }] });
    const ev = store.buildEvidence({ account, agent_id: "a1", session_ids: ["s1"] });
    const task = ev.entities.find((e) => e.kind === "task");
    assert.equal(task?.last_message_ref?.state, "unresolved_unknown_scope");
    assert.equal(ev.edges.some((e) => e.kind === "entry_id_ref"), false);
  });

  it("keeps one shared subagent entity with two reference edges", () => {
    const store = new EvidenceStore();
    store.ingestSubagents({ account, agent_id: "a1", ok: true, at: 1, subagents: [{ subagent_id: "sub", title: "Shared" }] });
    store.ingestTasks({
      account, agent_id: "a1", ok: true, at: 1,
      tasks: [
        { id: "t1", name: "one", subagent_ids: ["sub"] },
        { id: "t2", name: "two", subagent_ids: ["sub"] },
      ],
    });
    const ev = store.buildEvidence({ account, agent_id: "a1" });
    assert.equal(ev.entities.filter((e) => e.kind === "subagent").length, 1);
    assert.equal(ev.edges.filter((e) => e.kind === "subagent_ids_ref").length, 2);
  });

  it("enforces process-wide budgets and records an eviction gap rather than success", () => {
    const store = new EvidenceStore({ maxEntities: 3, maxActivityVersions: 3, maxSerializedBytes: 10_000_000 });
    store.ingestTasks({
      account, agent_id: "a1", ok: true, at: 1,
      tasks: [{ id: "t1" }, { id: "t2" }, { id: "t3" }, { id: "t4" }],
    });
    const ev = store.buildEvidence({ account, agent_id: "a1", consumed_scope_keys: [] });
    assert.ok(ev.budget.entities <= 3);
    assert.ok(ev.budget.evicted >= 1);
    assert.ok(ev.gaps.some((g) => g.kind === "evicted"));
    assert.equal(ev.entities.every((e) => e.view_status !== "succeeded"), true);
  });
});
