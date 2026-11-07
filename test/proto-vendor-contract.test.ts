/**
 * Contract tests for vendor/proto-gen (App 0.79.3 schema, regenerated in this repo).
 * Offline only: proves the vendored generated code encodes/decodes the fields this
 * project depends on with the expected field numbers, and that 0.79.x additive fields
 * exist and are wire-compatible with the old 0.78.4 shape (unknown-field tolerance).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { GrokBotService } from "#proto-gen/GrokBotService";
import * as ai from "#proto-gen/aiserver";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const T = (n: string): any => (ai as Record<string, unknown>)[n];

const USED_RPCS = [
  "createGrokBotTemporalAgent", "deleteGrokBotAgent", "getGrokBotSendStatus",
  "getGrokBotUserRuntimeSettings", "interruptGrokBotAgentRun", "listGrokBotAgentSessions",
  "listGrokBotAgentStatuses", "listGrokBotAgentTasks", "listGrokBotAgentTodos",
  "listGrokBotAgents", "listGrokBotSubagents", "listGrokBotTranscriptEntries",
  "sendGrokBotUserMessage", "updateGrokBotAgent", "updateGrokBotUserRuntimeSettings",
];

const snapshot = JSON.parse(
  gunzipSync(readFileSync(new URL("../docs/protocol/baselines/schema-0.79.3/snapshot.json.gz", import.meta.url))).toString("utf8"),
) as { messages: Record<string, { no: number; name: string }[]>; services: Record<string, { name: string; I: string; O: string }[]> };

test("all 15 used RPCs exist with signatures matching the archived 0.79.3 snapshot", () => {
  const snapRpcs = new Map(snapshot.services["aiserver.v1.GrokBotService"].map((r) => [r.name, r]));
  for (const m of USED_RPCS) {
    const gen = GrokBotService.methods[m];
    assert.ok(gen, `missing ${m}`);
    const s = snapRpcs.get(gen.name);
    assert.ok(s, `snapshot missing ${gen.name}`);
    assert.equal(gen.I.typeName, s.I);
    assert.equal(gen.O.typeName, s.O);
  }
  assert.equal(GrokBotService.typeName, "aiserver.v1.GrokBotService");
  assert.equal(Object.keys(GrokBotService.methods).length, 464);
});

test("new 0.79.x fields have the expected numbers and survive a binary round-trip", () => {
  const cases: [string, Record<string, unknown>, Record<string, number>][] = [
    ["GrokBotAgent", { sharedWithOthers: true }, { shared_with_others: 36 }],
    ["GrokBotAgentTask", { cloudAgentBcIds: ["bc1"], fileCount: 3, lastMessageEntryId: "e1", lastMessageAtMs: 1700000000000n },
      { cloud_agent_bc_ids: 12, file_count: 13, last_message_entry_id: 14, last_message_at_ms: 15 }],
    ["GrokBotUserRuntimeSettings", { userTimeZoneOverride: "Asia/Singapore", mainAgentTeamId: 7 },
      { user_time_zone_override: 16, main_agent_team_id: 17 }],
    ["SendGrokBotUserMessageRequest", { renderedCardKinds: ["k"] }, { rendered_card_kinds: 26 }],
    ["UpdateGrokBotUserRuntimeSettingsRequest", { userTimeZone: "UTC", userTimeZoneOverride: "UTC" },
      { user_time_zone: 13, user_time_zone_override: 14 }],
    ["GetGrokBotUserRuntimeSettingsRequest", { afterMainAgentChange: true }, { after_main_agent_change: 1 }],
    ["CreateGrokBotAgentRequest", { teamId: 5, botBuilderRequested: true }, { team_id: 19, bot_builder_requested: 20 }],
  ];
  for (const [name, init, nums] of cases) {
    const Msg = T(name);
    assert.ok(Msg, name);
    for (const [field, no] of Object.entries(nums)) {
      assert.equal(Msg.fields.findJsonName(field)?.no ?? Msg.fields.list().find((f: { name: string }) => f.name === field)?.no, no, `${name}.${field}`);
    }
    const m = new Msg(init);
    const back = Msg.fromBinary(m.toBinary());
    assert.ok(back.equals(m), `${name} round-trip`);
  }
});

test("long-standing used fields keep their numbers (matches snapshot)", () => {
  for (const name of ["GrokBotAgent", "GrokBotAgentTask", "SendGrokBotUserMessageRequest", "ListGrokBotAgentsResponse", "GrokBotUserRuntimeSettings"]) {
    const Msg = T(name);
    const snap = snapshot.messages[`aiserver.v1.${name}`];
    const gen = new Map(Msg.fields.list().map((f: { no: number; name: string }) => [f.no, f.name]));
    for (const f of snap) assert.equal(gen.get(f.no), f.name, `${name}#${f.no}`);
  }
});

test("bytes from a peer with new fields decode cleanly; unknown numbers are preserved", () => {
  const Agent = T("GrokBotAgent");
  // field 36 (shared_with_others, varint true) + an unknown field 999 (varint 1)
  const wire = new Uint8Array([0xa0, 0x02, 0x01, 0xb8, 0x3e, 0x01]);
  const a = Agent.fromBinary(wire);
  assert.equal(a.sharedWithOthers, true);
  assert.deepEqual(Array.from(a.toBinary()), Array.from(wire));
});
