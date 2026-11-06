# 协议映射与覆盖矩阵（细化）

基线：`grokbot-proto` @ **49fd8ce** / APP **0.78.4**。  
App 行为旁证：Linux **0.79.2** `main-app.pretty.cjs`（静态，未登录）。  
**0.78.4↔0.79.2 兼容未联调。**

## 覆盖矩阵

| App 动作 | 原生概念 | SDK 方法（建议） | CLI 示意（设计例，非现成命令） | MCP tool 示意 | RPC | 副作用 / 证据 |
|---|---|---|---|---|---|---|
| 列出 bots | Agent | `bot.list` | `gbc bot list --json` | `list_bots` | `ListGrokBotAgents` | 只读；可能 `truncated` |
| 查看 bot | Agent | `bot.get` | `gbc bot get --agent-id` | `get_bot` | **无 Get RPC**→list 筛选 | not_found |
| 创建 bot | Agent | `bot.create` | `gbc bot create --name …` | `create_bot` | **优先** `CreateGrokBotTemporalAgent`（I/O=CreateGrokBotAgent*） | 写；需预分配 `agent_id`；超时→unknown，禁止盲重试 |
| 更新 bot | Agent | `bot.update` | `gbc bot update …` | `update_bot` | `UpdateGrokBotAgent` | 写；`partial_update` |
| 删除 bot | Agent | `bot.delete` | `gbc bot delete --confirm=<id>` | `delete_bot` | `DeleteGrokBotAgent` | 写；App：NotFound→ok；**sidebar 清理未证** |
| 发消息 | UserMessage | `message.send` | `gbc message send --agent-id --session-id --text` | `send_message` | `SendGrokBotUserMessage` | 写；直接 RPC，**无强制 task** |
| 发送状态 | SendStatus | `message.status` | `gbc message status` | `get_send_status` | `GetGrokBotSendStatus` | 只读 |
| 历史 | Transcript | `message.history` | `gbc message history` | `list_transcript` | `ListGrokBotTranscriptEntries` | 只读；密文/省略不假装解密 |
| 会话列表 | Session | `session.list` | `gbc session list` | `list_sessions` | `ListGrokBotAgentSessions` | 只读 |
| 运行进展 | LiveState | `progress.status` | `gbc bot status` | `get_bot_status` | `ListGrokBotAgentStatuses` | 只读 |
| todos/tasks/subagents | 原生对象 | `progress.todos` 等 | `gbc bot todos`… | `list_agent_todos`… | `ListGrokBotAgentTodos` / `Tasks` / `Subagents` | 只读；≠自建 bridge_task |
| 中断 | Run | `progress.interrupt` | `gbc bot interrupt --confirm` | `interrupt_run` | `InterruptGrokBotAgentRun` | 写；作用域 agent(+session?) 待验 |
| **侧边栏分组读** | SidebarSections | `sidebar.get` | `gbc sidebar list` | `get_sidebar_sections` | `GetGrokBotUserRuntimeSettings` | 只读 |
| **侧边栏分组写** | SidebarSections | `sidebar.set/patch` | `gbc sidebar …` | `update_sidebar_sections` | `UpdateGrokBotUserRuntimeSettings`（仅 sections±base） | 写；冲突 best-effort；**删组≠删 bot** |
| 多 bot 房间 | Room | `room.*` | `gbc room …` | `create_room`… | `CreateGrokBotRoom` 等 | **非默认分组** |
| 团队组 | TeamGroup | `team.groups` | `gbc team groups` | `list_team_groups` | Dashboard `GetTeamGroups` | 权限/团队隔离；扩展 |

## Create 字段（已证实 vs 未证实）

**App 0.79.2 Temporal 创建路径已证实发送：**  
`agentId`(nonce)、`name`、`description`、`title`、avatar*、`harness=TEMPORAL`、`kickstartRequested`、`introductionSuppressed`（与 kickstart 联动）、`language`、可选 `createdAutomatically`。

**0.78.4 Request 另有：** `purpose`/`origin`/`create_intent`/`create_caller` 等——App 该路径未全用；控制面默认值待定。

**未证实 / drift：** App 代码还传 `visibility`/`teamId`/`botBuilderRequested`，**不在** 0.78.4 `CreateGrokBotAgentRequest` 字段表→标 schema drift，S0 必核。

## Sidebar 写语义（重点）

1. `get` → 得 `sections` 快照作 `base`  
2. 本地修改最小集合（增删 section、移动 `agent_ids`）  
3. `update({ sidebar_sections, sidebar_sections_base: base })`——**不**附带其它 runtime settings  
4. 回读 verify  
5. App 将部分失败映射为 `SidebarSectionsSaveConflictError`  

**无真正 ETag/版本字段名**；`base` 为乐观并发快照。跨 App 并发仍可能 lost update——文档不得承诺强一致。

## 版本兼容清单（S0）

- [ ] CreateGrokBotTemporalAgent 在 0.79.2 后端行为  
- [ ] Create 额外字段是否被忽略/拒绝  
- [ ] RuntimeSettings base 冲突错误码  
- [ ] `viewer_session_id` 作默认 session 是否总可用  
- [ ] Watch/List transcript 与加密可见性  
