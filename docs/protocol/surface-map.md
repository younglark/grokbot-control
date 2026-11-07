# Used protocol surface → SDK / CLI / MCP

Service `aiserver.v1.GrokBotService`. Field-level detail: [baselines/used-surface-0.79.2.json](baselines/used-surface-0.79.2.json).
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

Live note (2026-11-07): the three **L** reads succeeded with only `authorization: Bearer`.
No write RPC has been executed live.

## Key semantics (see also ../protocol-map.md)

- SidebarSections: `GrokBotSidebarSection{1 id, 2 name, 3 agent_ids*}`; write sends full `sidebar_sections` (6)
  plus `sidebar_sections_base` (12) as optimistic base. Server conflict code: unverified.
- Bot identity: `GrokBotAgent` has both `id` (1) and `agent_id` (12); Delete/Update requests take `id`;
  the code sends the public `agent_id` — **unverified live**.
- `SendGrokBotUserMessageRequest` enums `source`(13)/`initiator`(18)/`send_source`(21) are sent as 0 — unverified.
- `ListGrokBotTranscriptEntriesRequest.limit` (4) is not sent (0); client-side cap only.

## 0.79.2 additive fields relevant to this surface (not yet used)

From [baselines/used-surface-diff-0.78.4-to-0.79.2.md](baselines/used-surface-diff-0.78.4-to-0.79.2.md):
`CreateGrokBotAgentRequest` +18 visibility / +19 team_id / +20 bot_builder_requested;
`GetGrokBotUserRuntimeSettingsRequest` +1 after_main_agent_change; `GrokBotAgent` +36 shared_with_others;
`SendGrokBotUserMessageRequest` +26 rendered_card_kinds; runtime settings time-zone fields; `GrokBotAgentTask` +12..15.
