# 协议映射（grokbot-proto @ 49fd8ce / APP 0.78.4）

只读复核快照；**行为与 0.79.2 兼容未联调**。服务以 `aiserver.v1.GrokBotService` 为主；注明 Dashboard 处除外。

## A. Bot CRUD

| 操作 | RPC | 关键字段 |
|---|---|---|
| list | `ListGrokBotAgents` | 可选 `role` / team 相关；响应 `agents[]`（`GrokBotAgent`：`agent_id`/`id`/`name`/`title`/`viewer_session_id`…） |
| create | `CreateGrokBotAgent` | `name`/`description`/`title`/avatar…/`harness`/`create_intent`/`create_caller`… |
| update | `UpdateGrokBotAgent` | `id` + 可改字段；`partial_update` |
| delete | `DeleteGrokBotAgent` | `id` |
| （团队 bot 列表） | `ListGrokBotTeamAgents` | 与个人 list 区分 |

**待验：** 是否存在独立 `GetGrokBotAgent`；MVP 可用 list 过滤或 create/update 回包。`Duplicate`/`Publish` 等为扩展。

## B. 消息 / 会话 / 历史（直接，无强制 task）

| 操作 | RPC | 关键字段 |
|---|---|---|
| send | `SendGrokBotUserMessage` | **必填语义：** `agent_id`, `message_id`, `text`, `session_id`, `sent_at_ms`；另有 `source`/`initiator`/`send_source`/`task_id?`（可选，非本控制面自建账本） |
| send status | `GetGrokBotSendStatus` | `agent_id`,`message_id`,`session_id` → `GrokBotSendStatus` |
| history | `ListGrokBotTranscriptEntries` | `agent_id`,`session_id`,`limit`, 游标字段 |
| watch | `WatchGrokBotTranscripts` | stream；控制面可后接 |
| sessions | `ListGrokBotAgentSessions` | `agent_id` |
| interrupt | `InterruptGrokBotAgentRun` | `agent_id`,`reason`,`session_id?` |

**说明：** App 发消息不依赖本项目自建 task 状态机；`task_id` 若传，是协议可选字段，不是「必须先 submit_task」。

## C. 进展 / 状态

| 操作 | RPC | 备注 |
|---|---|---|
| live status | `ListGrokBotAgentStatuses` | `GrokBotAgentStatus.live` → `is_running` / `awaiting` / `last_turn_settlement`… |
| todos | `ListGrokBotAgentTodos` | |
| tasks | `ListGrokBotAgentTasks` | 原生 AgentTask，≠ 旧 bridge_task |
| subagents | `ListGrokBotSubagents` | |
| mark task done/read | `MarkGrokBotAgentTaskDone` / `MarkGrokBotAgentTaskRead` | 扩展谨慎 |

## D. 分组（三类，禁止混为一谈）

### D1. 侧边栏 SidebarSections（**分组默认候选**）

| | |
|---|---|
| 读 | `GetGrokBotUserRuntimeSettings` → `settings.sidebar_sections`（`GrokBotSidebarSections`） |
| 写 | `UpdateGrokBotUserRuntimeSettings`：`sidebar_sections` + 可选 `sidebar_sections_base`（并发基线，待验） |
| 结构 | `GrokBotSidebarSection`：`id`, `name`, `repeated agent_ids` |
| 单 bot 显隐 | `SetGrokBotAgentClientState`：`hidden_from_sidebar`；状态里还有 `removed_from_sidebar` |

### D2. Room（多 bot 对话房间）

`CreateGrokBotRoom`、`SetGrokBotRoomMembers`、`AddGrokBotRoomPeople`、`RemoveGrokBotRoomPeople`、成员回合相关 RPC…  
**不是**侧边栏文件夹的默认映射。

### D3. TeamGroup（团队组织）

`DashboardService.GetTeamGroups`；GrokBot 侧另有 TeamGroup Sand setup manifests。  
**不是**个人侧边栏 section。

### D4. LibraryPins（易混淆）

`List/Set/MergeGrokBotLibraryPin*`：bot 内文档/媒体钉，**不是**侧边栏 section。

## E. 鉴权相关（非 GrokBot CRUD，见鉴权报告）

独立浏览器 loginDeepControl + `/auth/poll`；Bearer；Cursor vs xAI identity；**禁止**读桌面 sand-secrets。GetMe 在 `DashboardService`。

## F. 明确不映射到控制面 MVP

Admin*、Internal*、Vault 明文、支付、未授权的秘密提交路径。
