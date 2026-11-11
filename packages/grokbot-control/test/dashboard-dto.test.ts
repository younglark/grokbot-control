/**
 * Phase-2 dashboard DTO mapping tests. Synthetic data only.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapSubagent, mapTask, mapTodo, mapTodoStatus, mapTodos } from "../src/ops/map.js";
import { mapUsageBreakdown, breakdownRowsForBot } from "../src/ops/usage.js";
import { usageBreakdownFixtureResponse } from "../src/testing/mock-transport.js";
import { mapTimelineEntry, mapTimelineEntries } from "../src/ops/transcript-map.js";
import { presentSessionView } from "../src/localdash/sessions.js";
import { formatUsagePpm } from "../src/localdash/view.js";

describe("stable todo / task / subagent DTOs", () => {
  it("maps TodoItem statuses and drops items without an id", () => {
    assert.equal(mapTodoStatus(1), "pending");
    assert.equal(mapTodoStatus("TODO_STATUS_IN_PROGRESS"), "in_progress");
    assert.equal(mapTodoStatus("cancelled"), "cancelled");
    assert.equal(mapTodoStatus(99), "unknown");
    assert.equal(mapTodo({ content: "no id" }), undefined);
    const todo = mapTodo({
      id: "t1",
      content: "写报告",
      status: 2,
      created_at: 10n,
      dependencies: ["t0"],
    });
    assert.deepEqual(todo, {
      id: "t1",
      content: "写报告",
      status: "in_progress",
      created_at: "10",
      dependencies: ["t0"],
    });
    assert.equal(mapTodos([{ content: "skip" }, { id: "keep", status: "pending" }]).length, 1);
  });

  it("maps tasks and subagents only when identifiers are present", () => {
    assert.equal(mapTask({ name: "nope" }), undefined);
    const task = mapTask({
      id: "task-1",
      name: "调研",
      status: "open",
      updatedAtMs: 99n,
      subagentIds: ["s1"],
      followed: true,
      fileCount: 3,
    });
    assert.equal(task?.id, "task-1");
    assert.equal(task?.name, "调研");
    assert.equal(task?.updated_at_ms, "99");
    assert.deepEqual(task?.subagent_ids, ["s1"]);
    assert.equal(task?.followed, true);
    assert.equal(task?.file_count, 3);
    assert.equal(mapSubagent({ title: "nope" }), undefined);
    const sub = mapSubagent({ subagentId: "s1", title: "检索", subagentType: "explore", startedAtMs: 1n });
    assert.equal(sub?.subagent_id, "s1");
    assert.equal(sub?.title, "检索");
    assert.equal(sub?.started_at_ms, "1");
  });
});

describe("GetGrokBotUsageBreakdown mapping", () => {
  it("maps by-source cents, by-bot cents, empty, and ppm fixtures without inventing a team id", () => {
    const cents = mapUsageBreakdown(usageBreakdownFixtureResponse("cents_by_source"));
    assert.equal(cents.kind, "billed_cents");
    assert.equal(cents.units, "unverified");
    assert.equal(cents.by_source[0]?.source, "user");
    assert.equal(cents.by_source[0]?.cents, "1234");
    assert.ok(cents.notes.some((n) => /未.*核实/.test(n)));
    assert.ok(cents.notes.some((n) => /enterprise_team_id|团队 id/.test(n)));

    const byBot = mapUsageBreakdown(usageBreakdownFixtureResponse("cents_by_bot"));
    assert.equal(byBot.by_bot.length, 2);
    const forOne = breakdownRowsForBot(byBot, { agent_id: "agent-1" });
    assert.equal(forOne.length, 1);
    assert.equal(forOne[0]?.cents, "800");
    assert.deepEqual(breakdownRowsForBot(byBot, { agent_id: "missing" }), []);

    const weekly = mapUsageBreakdown(usageBreakdownFixtureResponse("ppm_weekly"));
    assert.equal(weekly.kind, "weekly_limit_ppm");
    assert.equal(weekly.by_source[0]?.ppm, 225439);
    assert.equal(formatUsagePpm(weekly.by_source[0]!.ppm!), "22.54%");
    assert.ok(weekly.notes.some((n) => /百万分比/.test(n)));
    assert.doesNotMatch(weekly.notes.join("\n"), /占比未核实|单位未核实|是否为上限份额尚未核实|ppm 是否表示/);

    const billing = mapUsageBreakdown(usageBreakdownFixtureResponse("ppm_billing"));
    assert.equal(billing.kind, "billing_cycle_ppm");
    assert.equal(billing.by_source[0]?.ppm, 100000);
    assert.equal(formatUsagePpm(billing.by_source[0]!.ppm!), "10%");
    assert.doesNotMatch(billing.notes.join("\n"), /占比未核实|单位未核实/);

    const empty = mapUsageBreakdown(usageBreakdownFixtureResponse("empty"));
    assert.equal(empty.kind, "empty");
    assert.equal(empty.by_source.length, 0);
    assert.equal(empty.by_bot.length, 0);
  });
});

describe("transcript body parsing for the activity timeline", () => {
  it("parses UI-entry JSON bodies and marks omitted / opaque entries", () => {
    const body = Buffer.from(
      JSON.stringify({ id: "m1", kind: "message", role: "user", content: "你好", timestampMs: 1_700_000_000_000 }),
    );
    const entry = mapTimelineEntry({
      entryId: "m1",
      seq: 3n,
      entryKind: "message",
      body,
      bodyOmitted: false,
    });
    assert.equal(entry.decode_status, "decoded");
    assert.equal(entry.text, "你好");
    assert.equal(entry.role, "user");
    assert.equal(entry.untrusted, true);
    assert.equal(entry.seq, "3");

    const omitted = mapTimelineEntry({ entryId: "o1", entryKind: "message", bodyOmitted: true });
    assert.equal(omitted.decode_status, "omitted");
    assert.equal(omitted.text, undefined);

    const opaque = mapTimelineEntry({
      entryId: "x1",
      entryKind: "message",
      body: Buffer.from("not-json"),
    });
    assert.equal(opaque.decode_status, "opaque");
    assert.equal(opaque.decode_reason, "not_valid_utf8_json");

    const tool = mapTimelineEntry({
      entryId: "t1",
      entryKind: "tool-call",
      body: Buffer.from(JSON.stringify({ id: "t1", kind: "tool-call", name: "shell", summary: "ls", status: "ok" })),
    });
    assert.equal(tool.tool_name, "shell");
    assert.equal(tool.text, "ls");

    const page = mapTimelineEntries(Array.from({ length: 201 }, (_, i) => ({ entryId: String(i), entryKind: "notice", body: Buffer.from(JSON.stringify({ id: String(i), kind: "notice", text: "n" })) })));
    assert.equal(page.entries.length, 200);
    assert.equal(page.truncated, true);
  });
});

describe("session view selection", () => {
  const sessions = [
    { agent_id: "a", session_id: "sess-a", kind: "main" },
    { agent_id: "a", session_id: "sess-b", kind: "other" },
  ];

  it("uses the status session when it is in the list, and treats an unknown request as a visible failed switch", () => {
    const current = presentSessionView({ sessions, statusSessionId: "sess-a" });
    assert.equal(current.current_session_id, "sess-a");
    assert.equal(current.current_session_source, "status");
    assert.equal(current.viewed_session_id, "sess-a");
    assert.equal(current.switch_available, true);
    assert.match(current.note, /单独验收/);

    const switched = presentSessionView({ sessions, statusSessionId: "sess-a", requestedViewId: "sess-b" });
    assert.equal(switched.viewed_session_id, "sess-b");
    assert.equal(switched.switch_error, undefined);

    const bad = presentSessionView({ sessions, statusSessionId: "sess-a", requestedViewId: "missing" });
    assert.equal(bad.viewed_session_id, "sess-a");
    assert.match(bad.switch_error ?? "", /未切换/);
  });

  it("falls back to a read-only list when the current session cannot be confirmed", () => {
    const none = presentSessionView({ sessions, statusSessionId: "not-in-list", viewerSessionId: "" });
    assert.equal(none.current_session_source, "none");
    assert.equal(none.current_session_id, undefined);
    assert.equal(none.viewed_session_id, undefined);
    const viaViewer = presentSessionView({ sessions, viewerSessionId: "sess-b" });
    assert.equal(viaViewer.current_session_source, "viewer_session");
    assert.equal(viaViewer.viewed_session_id, "sess-b");
  });
});
