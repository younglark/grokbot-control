# 需求说明与订正

## 1. 首要产品定义

人原先在 **Grok Bot App** 里完成的驱动动作，改为由 **agent CLI 经 MCP 或本项目 CLI** 完成。  
上层 agent CLI 负责需求沟通与任务拆分/编排；本项目负责**尽量原样暴露 App 侧对 Bot 的控制能力**（直接读写原生 bot/session/message），**不**另建任务系统作为所有操作的前提。

验收理念：**App 可完成且纳入范围的动作，经 MCP 与 CLI 可等价完成**（仍受服务端权限与人工确认约束）；**不**模仿 GUI 点击。

## 2. 对旧交付的订正（必须）

| 偏离 | 订正 |
|---|---|
| 以自建 bridge_task / 账本 / 状态机为中心 | 基础操作为直接 RPC 映射；发消息 = `SendGrokBotUserMessage`，不经强制 `task submit` |
| bot CRUD 被降为 P1 | **MVP 必须含** create / list / get-or-read / update / delete |
| 分组默认不做或猜成 Room | **分组优先 = App 侧边栏 SidebarSections**；Room / TeamGroup **分命令**，见 protocol-map |
| mock 测试当 MVP 交付 | mock 仅离线证据；真机验收另授后才算交付 |
| 用 task-bridge 仓当产品 | 旧仓保留参考；**本仓 grokbot-control 为重新规划起点** |

## 3. 原始用户需求 → 纳入范围（MVP 基础）

来自用户最初明确列举，且与「App 里人会做的事」对齐：

1. 创建 / 删除 / 列表 / 更新 bot  
2. 向 bot **直接发消息**，查发送状态、会话/历史  
3. **分组**（优先侧边栏 section；非默认 Room）  
4. **进展**：运行状态、todos、tasks、subagents、interrupt  
5. **MCP + CLI 同时**作为控制入口  

上层 agent 的「拆任务→调度」是**工作流用法**，可选聚合层（P1），**不得**挡住基础增删与发消息。

## 4. 范围追踪表（摘要；细节见 protocol-map）

| 用户/App 意图 | 核心 API 语义 | CLI 示意 (`gbc`) | MCP tool 示意 | 主 RPC（0.78.4） | 真机验收 |
|---|---|---|---|---|---|
| 列出 bot | bot.list | `bot list` | `list_bots` | `ListGrokBotAgents` | 另授 |
| 创建 bot | bot.create | `bot create` | `create_bot` | `CreateGrokBotAgent` | 另授 |
| 读/描述 bot | bot.get | `bot get` | `get_bot` | 列表字段 / 后续补 Get 若有 | 另授 |
| 更新 bot | bot.update | `bot update` | `update_bot` | `UpdateGrokBotAgent` | 另授 |
| 删除 bot | bot.delete | `bot delete` | `delete_bot` | `DeleteGrokBotAgent` | 另授+防误删 |
| 发消息 | message.send | `message send` | `send_message` | `SendGrokBotUserMessage` | 另授 |
| 发送状态 | message.status | `message status` | `get_send_status` | `GetGrokBotSendStatus` | 另授 |
| 历史 | message.history | `message history` | `list_transcript` | `ListGrokBotTranscriptEntries` / `WatchGrokBotTranscripts` | 另授 |
| 会话列表 | session.list | `session list` | `list_sessions` | `ListGrokBotAgentSessions` | 另授 |
| 运行进展 | bot.status | `bot status` | `get_bot_status` | `ListGrokBotAgentStatuses` | 另授 |
| todos/tasks/subagents | bot.todos/… | `bot todos` 等 | 对应 list_* | `ListGrokBotAgentTodos` / `Tasks` / `Subagents` | 另授 |
| 中断 | bot.interrupt | `bot interrupt` | `interrupt_run` | `InterruptGrokBotAgentRun` | 另授 |
| **侧边栏分组** | sidebar.sections | `sidebar …` | `get/update_sidebar_sections` | `Get/UpdateGrokBotUserRuntimeSettings`（`sidebar_sections`） | 另授+语义确认 |
| 多 bot 房间 | room.* | `room …` | `create_room` 等 | `CreateGrokBotRoom` / `SetGrokBotRoomMembers` … | 扩展，**≠ 侧边栏分组** |
| 团队组 | team.groups | `team groups` | `list_team_groups` | Dashboard `GetTeamGroups` | 扩展，**≠ 侧边栏** |

## 5. 唯一需用户确认的分组语义

协议已证明存在三类不同概念：

1. **SidebarSections**（`GrokBotUserRuntimeSettings.sidebar_sections`）：section 含 `id`/`name`/`agent_ids`——**最贴近 App 侧边栏分组**  
2. **Room**：多 bot 对话房间（`CreateGrokBotRoom` 等）  
3. **TeamGroup**：团队组织组（Dashboard `GetTeamGroups`）

**默认计划：用户说的「分组」= SidebarSections。**  
若你的 App 里「分组」其实指 Room 或 TeamGroup，只需确认一次；三类命令会分开暴露，不会合并猜死。

## 6. 明确不做

- 替代 Grok Build / OpenCode / Codex  
- 导出 Admin / Internal / Vault 明文 / 支付 / auto-approve  
- 把 mock 绿当作 live 完成  
- 读取桌面 `sand-secrets` 或未授权生产调用  
- 无声把基础增删/发消息推到 P1  

## 7. 扩展产品域（非 MVP 全量，按域列）

例：automations/routines、email、meetings、marketplace、connectors、sandbox、library pins（文档钉，≠ 侧边栏 section）。按需分期，不一次 607 RPC。
