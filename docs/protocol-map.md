# 协议映射与覆盖矩阵（细化）

基线：vendor = App **0.79.3**（本仓库从App恢复生成，见 docs/protocol/baseline-manifest.md；此前为 `grokbot-proto` @ 49fd8ce / 0.78.4）。
App 行为旁证：Linux **0.79.2** `main-app.pretty.cjs`（静态，未登录）。  
**0.78.4→0.79.3 used surface 0 breaking（仅新增字段）；0.79.3 vendor 仅离线验证，未联调。**

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

**未证实：** App 代码还传 `visibility`/`teamId`/`botBuilderRequested`；0.79.3 vendor 已含这些字段（+18/+19/+20），但取值语义未经 live 验证，本实现仍**不发送**。

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

## Contract updates (review fixes on top of 14b88bf)

- `sidebar delete` / `delete_sidebar_section`: non-dry-run requires `confirm == section_id` in the SDK (CLI and MCP identical); otherwise `denied` (exit 7), no write.
- Value flags: `--flag value` or `--flag=value`. Missing value or next token starting with `--` → `usage` (exit 2). Dash-leading literals use `--text=--literal`. `--text-file` missing/unreadable → exit 2.
- Mutation RPCs (create/update/delete bot, send, sidebar write, interrupt): `unavailable`/`internal`/`unknown`/`resource_exhausted`/`deadline_exceeded`/`canceled`/transport errors → `outcome=unknown`, `retryable=false`, exit 10. Reads keep `unavailable` retryable (exit 8).
- Sidebar writes are read back: section id order + names + agent membership (set) must match; in-section `agent_ids` order is not compared. Mismatch or read-back failure → `sidebar_unverified`, `outcome=unknown`, exit 10, `details.diff`.
- `GBT_TRUST_BACKEND` / `--trust-backend`: only exact `"1"` trusts a non-allowlisted backend (SDK/CLI/MCP).
- `limit` (bot list, message history; CLI/MCP/SDK): integer 1..1000, default 50; invalid → `invalid_argument`/`usage` exit 2, no RPC.
- `bot get`: match missing in a server-`truncated` list → `lookup_incomplete` (`outcome=unknown`, exit 10), not `not_found`.

### Still unverified against the live server (mock/fake passing is not live proof)
- `DeleteGrokBotAgent{id}` / `UpdateGrokBotAgent{id}` are sent the public `agent_id`; whether proto `id` ≠ `agent_id` live (which would make delete NotFound→ok a false success) is unverified. Not changed.
- `SendGrokBotUserMessage` sends `source`/`initiator`/`send_source` = 0 (UNSPECIFIED). Not changed.
- `ListGrokBotTranscriptEntries` sends `limit=0`, `session_id=""`; server meaning of 0 unverified; client-side cap only.
- Real error code for a stale `sidebar_sections_base` (assumed `failed_precondition`/"conflict").
- Whether the server reorders `agent_ids` (treated as unordered) or sections (treated as ordered).
- Sidebar cleanup after bot delete; idempotency of `message_id`/`agent_id` on retry.

## Auth (independent Cursor browser login)

Source: STATIC reverse engineering of Grok Bot Linux 0.79.2 (`/workspace/grokbot-linux-auth-analysis.md`,
`evidence/main-app.pretty.cjs` = A, `main-core.pretty.cjs` = C). Not official public documentation.

| Step | Implementation | Evidence |
|---|---|---|
| Challenge | verifier = base64url(32 random bytes); challenge = base64url(SHA256(verifier)); uuid v4 | A:38644-38657 |
| Login URL | `https://cursor.com/loginDeepControl?challenge&uuid&mode=login&redirectTarget=cli` | A:38644-38657, A:38845 (library default `cli`; App uses `sand`, A:49834) |
| Poll | `GET {backend}/auth/poll?uuid&verifier`; 404 pending; 1s×1.2^i ≤10s; ≤150 tries; 3 consecutive non-404 → stop; 403 `sign_in_policy_violation` → denied | A:38720-38816 |
| Result | `{accessToken, refreshToken}` stored; `{xaiAccessToken,…}` → unsupported | A:38584-38622 |
| Refresh | `POST {backend}/oauth/token` JSON `{client_id, grant_type:"refresh_token", refresh_token}`; response `{access_token, refresh_token?, shouldLogout?, error?}`; 300s early window | A:56108-56125, A:54459, C:35811 |
| client_id | App picks a public id per backend (C:35866-35869). **Not embedded**; set `GBT_OAUTH_CLIENT_ID` explicitly | analysis §6 |

CLI: `auth login-begin` → `auth complete [--timeout 1..900]` (cross-process via 0600 pending file, 15 min TTL),
or `auth login`; `auth poll` (single), `auth cancel`, `auth refresh`, `auth whoami`, `auth logout` (local only).
MCP: `auth_whoami`, `auth_login_begin`, `auth_login_complete` (≤120 s), `auth_login_cancel`, `auth_logout`
(available in `GBT_MCP_READONLY=1`). Failure semantics: refresh network/5xx → retryable, creds kept;
4xx/bad payload → creds kept; `shouldLogout` → local cred removed. Missing/expired token → `unauthenticated`
(exit 4) before any RPC is sent.

### Live status (2026-11-07, one manual run)
- Verified live: browser login (`loginDeepControl`, `redirectTarget=cli`) → `GET /auth/poll` → Cursor token (kind `cursor`, backend api2);
  read-only RPCs `ListGrokBotAgents`, `GetGrokBotUserRuntimeSettings` (sidebar), `ListGrokBotAgentStatuses` succeeded with only `authorization: Bearer`.
- NOT verified live: token refresh (`GBT_OAUTH_CLIENT_ID` still must be configured), all write RPCs, history/session/todos/tasks.

### Auth items still unverified live
- Whether `supportsSelectedTeamLogin` / team selection (`x-cursor-team-id`) is needed for Grok Bot RPCs.
- Whether write RPCs need App headers (`x-cursor-client-type`, version, `x-ghost-mode`, …); reads worked with Bearer only.
- Which public client_id is appropriate for a third-party tool; refresh is off until configured.
- Login/refresh device-policy header `x-cursor-mdm-signin-policy` is not sent (not forged).
