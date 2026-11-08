# Used protocol surface → SDK / CLI / MCP

Service `aiserver.v1.GrokBotService`. Field-level detail: [baselines/used-surface-0.79.3.json](baselines/used-surface-0.79.3.json) (vendor = 0.79.3).
The RPC list is derived from code (`client.<rpc>(` in `src/`) by `tools/protocol/used_surface.py`.

| RPC | SDK (`src/ops`) | CLI | MCP tool | Write? | Level |
|---|---|---|---|---|---|
| ListGrokBotAgents | `bot.list` / `bot.get` | `bot list`, `bot get` | `list_bots`, `get_bot` | no | **L** (2026-11-07) |
| CreateGrokBotTemporalAgent (req `CreateGrokBotAgentRequest`) | `bot.create` | `bot create` | `create_bot` | yes | S + O |
| UpdateGrokBotAgent | `bot.update` | `bot update` | `update_bot` | yes | S + O |
| DeleteGrokBotAgent | `bot.delete` | `bot delete --confirm` | `delete_bot` | yes | S + O |
| SendGrokBotUserMessage | `message.send` | `message send` | `send_message` | yes | S + O |
| GetGrokBotSendStatus | `message.status` | `message status` | `get_send_status` | no | S + O |
| ListGrokBotTranscriptEntries | `message.history` | `message history` | `list_transcript` | no | S + O |
| ListGrokBotAgentSessions | `session.list` | `session list` | `list_sessions` | no | S + O |
| ListGrokBotAgentStatuses | `progress.status` | `bot status` | `get_bot_status` | no | **L** (2026-11-07) |
| ListGrokBotAgentTodos / Tasks, ListGrokBotSubagents | `progress.*` | `bot todos/tasks/subagents` | `list_agent_todos`, `list_agent_tasks`, `list_agent_subagents` | no | S + O |
| InterruptGrokBotAgentRun | `progress.interrupt` | `bot interrupt --confirm` | `interrupt_run` | yes | S + O |
| GetGrokBotUserRuntimeSettings | `sidebar.list` | `sidebar list` | `get_sidebar_sections` | no | **L** (2026-11-07) |
| UpdateGrokBotUserRuntimeSettings (`sidebar_sections` + `sidebar_sections_base`) | `sidebar.*` patch + read-back | `sidebar create/rename/delete/move` | `*_sidebar_section`, `move_bot_to_sidebar_section` | yes | S + O |
| GetSandBoxRunState | `computer.state` | `computer state` | `get_computer_state` | no | S + O |
| RecreateSandBox (`preserve_data:false`) | `computer.reset` | `computer reset --confirm=RESET_COMPUTER` | `reset_computer` | yes | S + O |
| ForceRecreateSandBox | `computer.reset --hard` | `computer reset --hard --confirm=RESET_COMPUTER` | `reset_computer(hard=true)` | yes | S + O |
| WatchSandBoxMigration | `computer.reset --wait` | `computer reset --wait` | `reset_computer(wait_seconds<=30)` | no | S + O |

Live note (2026-11-07): the three **L** reads succeeded with only `authorization: Bearer`.
No write RPC has been executed live.

## Key semantics (see also ../protocol-map.md)

- SidebarSections: `GrokBotSidebarSection{1 id, 2 name, 3 agent_ids*}`; write sends full `sidebar_sections` (6)
  plus `sidebar_sections_base` (12) as optimistic base. Server conflict code: unverified.
- Bot identity: `GrokBotAgent` has both `id` (1) and `agent_id` (12); Delete/Update requests take `id`;
  the code sends the public `agent_id` — **unverified live**.
- `SendGrokBotUserMessageRequest` enums `source`(13)/`initiator`(18)/`send_source`(21) are sent as 0 — unverified.
- `ListGrokBotTranscriptEntriesRequest.limit` (4) is not sent (0); client-side cap only.
- `computer reset --wait` filters `WatchSandBoxMigration` events by `operation_id` and reports
  phases only (`backing-up`, `creating`, `moving`, `cleaning-up`, `wiping`, `done`/`failed`);
  the protocol has no percentage. Live reset/progress is unverified.

## 0.79.x additive fields relevant to this surface (present in vendor, not used/exposed)

From [baselines/used-surface-diff-0.78.4-to-0.79.3.md](baselines/used-surface-diff-0.78.4-to-0.79.3.md) (identical to the 0.79.2 diff):
`CreateGrokBotAgentRequest` +18 visibility / +19 team_id / +20 bot_builder_requested;
`GetGrokBotUserRuntimeSettingsRequest` +1 after_main_agent_change; `GrokBotAgent` +36 shared_with_others;
`SendGrokBotUserMessageRequest` +26 rendered_card_kinds; runtime settings time-zone fields; `GrokBotAgentTask` +12..15.
