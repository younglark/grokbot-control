# Changelog

本文件记录公开包 `grokbot-control` 的用户可见变更。版本号遵循 SemVer。从 0.2.0 起通过 GitHub tag `npm-v<version>` 分发，不再发布到 npmjs。npmjs 上的 **0.1.3 已停止更新**。

## Unreleased

### 新增

- **`gbc message wait`（#2）。** `gbc message wait --agent-id <id> --message-id <mid> [--session-id <sid>] [--timeout 600] [--interval 3] [--full]` 轮询 `ListGrokBotAgentStatuses`，等这条消息开启的回合结束（settle），再返回该回合 echo 之后的 transcript 条目。
  - 完成判定优先看 `live.last_turn_settlement.turn_id == message_id`（`completion_basis:"turn_settlement"`，`outcome` 为 `success` / `cancelled` / `error`，带 `settled_at_ms`）。**turn_id 与 message_id 的对应关系来自对官方 App 0.79.4 的静态分析（`main-app.cjs` 的 `sendPrompt` 发 `messageId: clientNonce`；coordinator 把 `lastTurnSettlement.turnId` 当作 `clientNonce`），未经 live 验证。**
  - 兜底（`completion_basis:"running_transition"`，`outcome:"unknown"`）：`GetGrokBotSendStatus` 已是 `accepted`、受理之后观察到过 running、现在不 running。只看到 `is_running=false` 不算完成。
  - 「做完」= 这一轮回合 settle，不等子任务；结果带 `has_running_subagents` 和 `working_task_ids`。
  - `replies` 是 `echo_entry_id` 之后（按 `seq`）的条目，解码和 `message history` 相同（默认 2000 字，`--full` 取全文）。会话取 `--session-id`，否则取 live 状态里的 `session_id`；找不到 echo 或会话时 `replies` 为空，`replies_basis` / `replies_note` 说明原因，不猜。
  - 进度以 JSON 行写到 stderr。超时：`ok:false`、`code:"wait_timeout"`、`outcome:"unknown"`、退出码 10（与 `computer reset --wait` 一致），`error.details.last_live` 带最后一次 live 状态。发送状态 `rejected`：`code:"message_rejected"`，退出码 7；连续 3 次 `not_found`：`code:"message_not_found"`，退出码 5。SIGINT：退出码 10。
- **MCP `wait_for_message`**（只读）：`wait_seconds` 0..30（默认 0，只查一次）。没结束时返回 `ok:true`、`code:"pending"`、`data.state:"pending"`，调用方用同一 `message_id` 再查，并把上次的 `observed_running` 传回（MCP 调用之间不保存状态）。结束时的 `data` 与 CLI 相同。
- **SDK**：`plane.message.wait(input)`，导出 `MessageWaitInput` / `MessageWaitData` 等类型。
- **`gbc computer wake`、MCP `wake_computer`、SDK `computer.wake()`（#5）。** 非破坏性唤醒休眠的共享电脑，与 `computer reset` 完全分开，不需要确认词，需要 `--allow-writes`。只在 run state 为 hibernated 时发一次 `EnsureSandBox`，请求为空（与官方 App `connect()` 相同，不设 `wake`/`supports_asleep_box`，不带 App 的 `x-sand-box-park` 头），然后用 `GetSandBoxRunState` 读回；`--wait` 轮询到 running（`--timeout` 1..3600，默认 120；MCP `wait_seconds` 上限 30）。running → `already_running`（不发写）；starting → 不发写；absent/unspecified → `failed_precondition`（退出 7，不会借唤醒新建电脑）；仍 hibernated / 超时 / 读回失败 → `wake_unverified`、outcome unknown、退出 10。`--dry-run` 只读当前状态并报告将要做什么。输出白名单：run state 名字与 code、`image_update_available`、镜像信息；`EnsureSandBoxResponse` 里的 token、URL、cluster/pod 等一律不输出。不升级镜像、不 reset、不调 `EnsureSandBoxWindow`。**静态推断，未 live 验证；唤醒可能产生费用。** 证据见 [docs/protocol/computer-wake-0.79.4.md](https://github.com/younglark/grokbot-control/blob/main/docs/protocol/computer-wake-0.79.4.md)。
- `sidebar create --if-exists=reuse`（MCP `create_sidebar_section` 的 `if_exists:"reuse"`）：恰好有一个同名分组（精确、区分大小写）就复用，`existing:true`，不写；两个及以上同名报 `ambiguous_match`、退出码 6，`error.details.candidates` 列出 `section_id`。不传时行为不变（总是新建）。
- `bot create --if-exists=reuse`（MCP `create_bot` 的 `if_exists:"reuse"`）：先读一次 `ListGrokBotAgents`，按 `--agent-id`、`--name`，或服务端把 title 并进显示名后的 `"<name> · <title>"`（#3 观察到的分隔符 ` · `）匹配。匹配到一个就复用（`existing:true`、`matched_by` 为 `agent_id` / `name` / `merged_name`），不发创建，也不改描述、职称、语言。多个匹配报 `ambiguous_match`（6）；传了 `--agent-id` 但唯一同名 Bot 的 agent_id 不同报 `conflict`（6）；列表截断（且没有 agent_id 命中）或读取失败报 `lookup_incomplete`、`outcome:"unknown"`、退出码 10，都不创建。不传时行为不变。
- `sidebar move --section-name <name>`（MCP `section_name`）：与 `--section-id` 二选一，按唯一精确名匹配；同名多个 6，没有 5。
- 结果新增字段：`sidebar create` 带 `section_id`、`section`、`existing`；`sidebar move` 带 `agent_id`、`section_id`、`existing`、`skipped`；`bot create` 带 `existing`（以及复用时的 `matched_by`）。`--dry-run` 额外给 `would`（`create` / `reuse` / `move` / `skip`），不发写 RPC；`bot create --if-exists=reuse --dry-run` 会读一次列表，不带该参数的 dry-run 仍不发任何 RPC。
- 写失败时 `error.details` 带已确定的 id：`sidebar create` 带新分组的 `section_id`，`sidebar move` 带 `agent_id`、`section_id`，`bot create` 的创建 RPC 失败时带客户端生成的 `agent_id`（以及 `write_sent`），便于对账后重跑。
- 新退出码映射：`ambiguous_match` → 6（沿用 6 conflict 一类，退出码含义不变）。

可按名字重跑「建分组 → 建 Bot → 移入分组」的脚本（#6）。不新增名词，也没有任务系统；协议里没有按名字查找或幂等键的 RPC，都是先 list 再在客户端匹配。只做了离线（mock）验证，没有 live 检查。

### 行为变化

- **`sidebar move` 在 Bot 已经只在目标分组里时不再写入**：返回 `skipped:true`、`existing:true`，不发 `UpdateGrokBotUserRuntimeSettings`，也不需要 `--allow-writes`。以前会照样写一次并把 Bot 挪到该分组末尾，现在位置保持不变。Bot 已在目标分组、同时还在别的分组时，仍写一次去掉别处的副本，目标分组里的位置不变。MCP `move_bot_to_sidebar_section` 同步。

### 输出补充（只增字段）

- `bot status` / `get_bot_status` 的 `live.last_turn_settlement` 增加 `turn_id`（以前被丢掉），`live` 增加 `has_running_subagents`（服务端给了才有）。

## 0.6.1 — 2026-11-12（通过 GitHub tag `npm-v0.6.1` 分发，不发到 npmjs）

安装：`npx -y --package=github:younglark/grokbot-control#npm-v0.6.1 gbc`（`gbc-mcp` 同样要加 `--package`）。

协议升级到 Grok Bot App 0.79.4（#9）。**无破坏性变更**：控制面已用的 RPC/消息在 0.79.3 与 0.79.4 之间完全相同，CLI、MCP、SDK 的输入输出不变。同仓库的 `local-exec-daemon`（private，不随本包分发）没设版本环境变量时的内置兜底版本随之改为 0.79.4。

### 协议

- **`vendor/proto-gen` 改由 App 0.79.4 schema 生成**（新冻结目录 `schema-0.79.4` / `schema-0.79.4-daemon-exec`；0.79.3 目录保留）。0.79.4 只多了两个 optional 字段：`CompleteMcpOAuthRequest.oauth_error`（3）和 `CompleteMcpOAuthResponse.continue_authorization_url`（6），都不在本包用到的 RPC/消息里。已用面 0.79.3 → 0.79.4 完全相同，0 breaking；登录/poll/刷新等鉴权锚点与 0.79.3 相同，`src/auth/` 未改。CLI、MCP、SDK 行为不变。只做了离线验证，没有 live 检查。详见 [docs/protocol/app-0.79.4-delta.md](https://github.com/younglark/grokbot-control/blob/main/docs/protocol/app-0.79.4-delta.md)。

## 0.6.0 — 2026-11-12（通过 GitHub tag `npm-v0.6.0` 分发，不发到 npmjs）

安装：`npx -y --package=github:younglark/grokbot-control#npm-v0.6.0 gbc`（`gbc-mcp` 同样要加 `--package`）。

**含破坏性变更**：
- 解析 `message send` / `message status` / `message history` 的 `--json` 输出的脚本需要调整（枚举改为名字、`session_id` 改为 `null`、history 条目形状变化）。
- `message send` 遇到 `delivery=refused` 现在返回 `ok:false`、退出码 7（以前是 `ok:true`、退出码 0）。
- `bot create` / `bot update` 的 `data.bot` 改为读回的值；写成功但读回失败时返回退出码 10（以前是 0）；不传 `--title` 时发送 `""`。

`schema_version` 仍为 `1.0.0`（按仓库惯例它是封套版本，0.2.0 的 CLI 输出形状破坏性变更也没有升它）。

### Breaking

- **`message send` / `message status` 的枚举改为名字（#1）。** `delivery`、`status` 从 `"2"` 这样的数字字符串改为小写 snake 名字（如 `"accepted_temporal"`、`"accepted"`），数字移到 `delivery_code` / `status_code`。新增 `mode` / `mode_code`。名字表取自生成的冻结 schema 枚举；schema 没有的数值输出 `"unknown"` 加原始 code。
- **`session_id` 不再用 `""` 表示默认会话。** 调用方传了就回显并带 `session_source:"caller"`；没传时为 `null`、`session_source:"default_unreported"`（发送 RPC 不返回会话号）。`message history` 也带这两个字段。
- **`delivery=refused` 现在是失败。** 以前返回 `ok:true`、退出码 0。现在 `ok:false`、`code:"refused"`、退出码 7（与 denied 同一类：写请求被拒），错误封套在 stderr，`data` 里仍有 `refusal` 和 `workflow_id`；MCP `send_message` 返回 `isError:true`。
- **`message status` 的可选字段缺失时为 `null`**（`rejection_code`、`accepted_at_ms`，以及新增的 `echo_entry_id`），不再省略。
- **`message history` 条目形状变化（#2 的 history 部分）。** 以前读的是 schema 里不存在的 `plaintext` / `text` / `ciphertext`，真实数据永远没有正文，`entry_id` 也读错字段。现在与本地监视器 transcript 用同一解码器解析 `body`（UTF-8 JSON UI 条目）：条目带 `entry_id`、`seq`、`kind`、`role`、`timestamp_ms`、`decode_status`、`preview`（200 字）和 `text`（默认最多 2000 字，`--full` 取全文，被截断时有 `text_truncated` / `text_chars`）。`omitted` 只在服务端省略 body 时为 true。去掉误导性的「Ciphertext … not decrypted」说明。

### 新增

- `message send` 结果补上 `workflow_id`、`refusal{failure_code,message}`（缺失为 `null`）；`message status` 补上 `echo_entry_id`。
- `message history --session-id <sid>`（MCP `list_transcript` 的 `session_id`）：只在给出时发给服务端，不猜默认值。`--full`（MCP `full: true`）返回全文。
- 内部：`--mock` 后端的 transcript 改为 schema 形状（`body` 字节），使旧解码错误能被测试发现。
- **`bot create` / `bot update` 支持 `--description-file <path>`**（#4）。按 UTF-8 原样读取，换行保留，与 `message send --text-file` 共用同一个读文件函数。和 `--description` 同时出现、路径缺失或文件读不到都是用法错误（退出码 2），不会发出写请求。`-` 是文件名，不表示 stdin。MCP 的 `create_bot` / `update_bot` 直接收字符串，不新增文件参数。
- **`--help` 提示不要用 `echo` 重打印 `--json` 输出**（#4）。JSON 字符串里的换行是合法的 `\n` 转义，部分 shell 的 `echo` 会把它还原成真换行，导致解析失败。改用 `printf '%s' "$raw"` 或直接读 stdout。gbc 的 JSON 输出本身不变。

### 变更（行为变化）

- **`bot create` / `bot update` 写成功后从 `ListGrokBotAgents` 读回**（#3，CLI、MCP、SDK 一致）。最多读 3 次，退避 300ms / 900ms，总时长约 3 秒以内，只在列表完整但还找不到该 agent 时重试。结果新增 `requested{name,title}`（update 里未修改的字段为 `null`）、`observed{name,title}`、`renamed_by_server`、`changed_fields`、`readback.attempts`；`data.bot` 改为读回的版本，不再是写接口的回包。已观察到服务端会把 title 并进显示名（如 `Showrunner · 幕僚长`）并清空 title，这只来自 issue #3 的观察，客户端逆向里没有证据，也不保证所有账号都这样。
- **读回失败视为结果未知**：列表请求出错、列表被截断且没找到、或重试后仍找不到时，返回 `create_unverified` / `update_unverified`，`outcome: "unknown"`，退出码 10（与 `sidebar_unverified`、`computer reset --wait` 超时一致），`error.details` 里带 `agent_id`、`requested` 和写接口回包的 name/title 供对账。之前这些情况会直接报成功。
- **`--dry-run` 的 `note` 写明干跑无法发现服务端改名**；干跑结果也带 `requested` / `observed`（两者相同）和 `readback.attempts: 0`。
- **不传 `--title` 时发送 `title: ""`**，与官方 App 一致（0.79.3 `dist/electron-main/main-app.cjs` 第 1117 行 `createGrokBotTemporalAgent({…,title:n.title??"",…})`，0.79.4 相同）。之前会把 `name` 当 title 发送；干跑结果里的 `bot.title` 也随之变为 `""`。
- 每次真实 create / update 多一次（最多三次）`ListGrokBotAgents` 只读请求。

## 0.5.0 — 2026-11-11（通过 GitHub tag `npm-v0.5.0` 分发，不发到 npmjs）

### 新增

- **`gbc account cleanup`：删除当前账号自己拥有的个人 Bot，再按现有 `computer reset` 重建共享电脑。** 这不是彻底账号重置，也不处理订阅、账号删除、Library、会话、连接器或未经证实的云端副作用。先 `--dry-run` 预览清单、数量、数据损失提示和计划指纹；真实执行必须 `--allow-writes`、`--confirm=ACCOUNT_CLEANUP` 以及与当前清单匹配的 `--plan=<fingerprint>`。清单被截断、权属不明、共享/团队/他人 Bot、或预览后列表变化时不会发出写请求。删除串行报告；任一条失败或结果未知则停止且不重建。重建前会再次只读核验，出现残留或新的可删 Bot 时不会继续删除或重置。0 个自有 Bot 在空计划匹配后仍可重建。`--hard` / `--wait` / `--timeout` 复用现有电脑重置语义。流程不是事务，已删除的 Bot 不能用本命令撤销。没有 dashboard 写入口，也不新增 MCP 工具。既有的单 Bot `bot delete` 和 `computer reset` 保持不变。

安装：`npx -y --package=github:younglark/grokbot-control#npm-v0.5.0 gbc`（`gbc-mcp` 同样要加 `--package`）。

## 0.4.2 — 2026-11-11（通过 GitHub tag `npm-v0.4.2` 分发，不发到 npmjs）

源码 tag `v0.4.1` 已推送，但打 `npm-v` 时因 `npm pack --json` 的 stdout 被 vite 日志污染，**没有生成 `npm-v0.4.1`**。请不要删除或改写已推送的 `v0.4.1`。0.4.2 修复发版脚本解析，是该线上应由 Actions 生成的 GitHub 安装 tag。

### 修复

- **发版脚本能解析 `npm pack --json` 前的 vite/tsc 日志。** `prepack` 可能把带 ANSI 颜色的构建输出写到 stdout，导致 `scripts/release-github.mjs` 对整段 stdout 做 `JSON.parse` 失败。现与 `scripts/verify-package.mjs` 共用末尾 JSON 数组解析，不再因日志前缀铸不出 `npm-v*` tag。

安装：`npx -y --package=github:younglark/grokbot-control#npm-v0.4.2 gbc`（`gbc-mcp` 同样要加 `--package`）。

## 0.4.1 — 2026-11-11（行为变更已进入 main；`npm-v0.4.1` 未生成）

源码 tag `v0.4.0` 已推送，但发版工作流在 `npm test` 处因 Playwright/Chromium dashboard UI 验收失败，**没有生成 `npm-v0.4.0`**。请不要删除或改写已推送的 `v0.4.0`。0.4.1 去掉这些重浏览器测试，是该线上应由 Actions 生成的 GitHub 安装 tag。

### 修复

- **默认 `npm test` 不再跑依赖 Playwright Chromium 的 dashboard UI 验收。** `packages/grokbot-control/test/dashboard-ui.test.ts` 只保留打包树存在性与 `resolveDashboardUiRoot` 等轻量检查。Workspace regression 不再执行 `npx playwright install --with-deps chromium`，也从 devDependencies 移除 playwright。未安装浏览器时，发版工作流不应再因「Chromium required…」失败。

## 0.4.0 — 2026-11-11（行为变更已进入 main；`npm-v0.4.0` 未生成）

### 新增

- **本地只读监视器：`gbc dashboard`（亦接受 `gbc dashboard start`）。** 在回环地址启动一个近实时 Bot 监视页（本地轮询 + SSE），打印并打开带一次性路径 `/s/<随机>/` 的 URL。这是 CLI 命令，**不是**官方 protobuf `DashboardService`。不会通过 CLI、MCP 或 HTTP 暴露官方写 RPC（`Set*`、`ExecuteSandMcpTool`、`CancelSandTrial`、`SendTeamInvite` 等）。默认绑定 `127.0.0.1`，v1 拒绝非回环 `--host`。未登录时服务器仍会启动，页面提示在终端运行 `gbc auth login` 后刷新；页面不收集凭据。`--json` 输出一次含 `url` / `bind` / `opened` 的封套后保持运行；`--plain` 只打印 URL；`--no-open` 不打开浏览器。Ctrl+C / SIGTERM 退出码 0，不会中断远端 Bot。没有 v1 MCP dashboard 工具。
- **本地监视器补充协议里已有的 Bot 信号。** 详情与总览只读展示：等待处理（审批、等待输入、桌面交接、正在重试）、当前动作（正在调用的工具/步骤与 `last_turn_settlement`）、数据新鲜度（上次成功刷新、分源失败/重试；空列表与读失败可区分）、最近动态（最后活动时间、未读、todo 创建/更新时间）、运行环境（共享电脑/沙箱是否在跑；未知或过期不会显示为绿色「运行中」）、渠道连接（Slack/Teams 是否已接上）。桌面交接指令只给收敛摘要；渠道展示不含 install/reinstall URL。不引入 Watch，也不展示资料类的创建时间、可见性或语音字段。
- **第二期：任务区、活动时间线与用量明细。** 打开某个 Bot 详情时，约 10 秒轮询该 Bot 的 sessions / todos / tasks / subagents（多标签共享缓存 + singleflight，不会把全局 5 秒状态轮询按 Bot 放大）。用已有 history/transcript SDK 解析消息正文，展示活动时间线：运行中或等待中约 5 秒，否则 15–30 秒，仅活动列表离开视口时暂停刷新；浏览较早内容时显示「有新活动」，不强制滚到底部。`GetGrokBotUsageBreakdown` 首次调用不传 team id；若明细里带有 `bot_id`，对应 Bot 详情也会展示。todos / tasks / subagents 使用稳定 DTO；没有可靠数据时不编造待办。会话切换是本地查看成绩单的明确能力，需单独验收，不是默认关键路径；数据不足时只提供只读会话列表与当前会话，失败可见。

### 说明

- 「近实时」是本地轮询 + SSE，不是 `WatchGrokBotTranscripts`（该 RPC 不在已用表面，也未接线）。
- `computer.state` 未经实时核验；未知或过期状态不会显示为绿色「运行中」，也不等同于离线。
- `usage_percent` 按已经算好的百分比展示（例如 21.781372 显示为 21.78%），不再标注该字段「单位未核实」，也不会把 0–1 小数再乘 100。breakdown 中的 ppm 是占限额的百万分比，换算为百分比展示（例如 225439 ppm 显示为 22.54%），不再写成 225439%，也不再标注该字段「占比未核实」。金额/币种仍尚未 live 核实；包含额度为 0 时不绘制满额进度条；计费链接仅在接口返回完整 URL 时展示，不会拼接。不会猜测 team id 去取企业支出或事件。
- 会话切换尚未作为默认关键路径验收：当前实现是本地只读查看成绩单，不是官方会话切换写操作。
- OAuth 刷新仍未 live 核实。

## 0.3.0 — 2026-11-11（通过 GitHub tag `npm-v0.3.0` 分发，不发到 npmjs）

### 新增

- **可选 bot 登录模式。** 默认仍是 CLI 登录（`redirectTarget=cli`，不加团队选择参数）。`--login-mode bot`、`GBT_LOGIN_MODE=bot` 或 MCP `login_mode: "bot"` 会使用与桌面 App 相同的 `loginDeepControl` URL（`redirectTarget=sand` + `supportsSelectedTeamLogin=true`）。不读取官方 App 凭据，也不发送官方客户端头。
- **bot 模式登录轮询收束已 live 验证（2026-11-11）。** 得到 Cursor token（kind `cursor`，backend api2）。选中团队如何返回/绑定、是否需要 `x-cursor-team-id`、以及该模式之后的 OAuth 刷新仍未 live 验证。

### 修复

- **冲突的 `--login-mode` 不再静默后写覆盖。** 两个不一致的值以退出码 2（`usage`）失败；同一个值写两次可以通过。命令行参数覆盖 `GBT_LOGIN_MODE`。

安装：`npx -y --package=github:younglark/grokbot-control#npm-v0.3.0 gbc`（`gbc-mcp` 同样要加 `--package`）。

## 0.2.1 — 2026-11-10（通过 GitHub tag `npm-v0.2.1` 分发，不发到 npmjs）

源码 tag `v0.2.0` 已推送，但发版工作流在 `npm test` 处因后台 shell 测试挂起被取消，**没有生成 `npm-v0.2.0`**。请不要删除或改写已推送的 `v0.2.0`。0.2.1 是第一个应由 Actions 生成的 GitHub 安装 tag。

### 修复

- **CI / 本地 `npm test` 不再在 `t181` 之后挂死。** `BackgroundShellManager.adopt()` 在子进程已退出（例如 `echo` 在 adopt 之前结束）时会漏掉 `close`，5 秒一次的 terminal header `setInterval` 会一直占住事件循环，`node --test` 无法进入后续文件。GitHub Actions 上曾卡在「BACKGROUND handoff…」之后直至任务被取消。现已在挂上 listener 后处理 `exitCode`/`signalCode` 已存在的子进程，并补了无 TTY 下「adopt 已退出子进程后进程必须退出」的回归测试。

安装：`npx -y --package=github:younglark/grokbot-control#npm-v0.2.1 gbc`（`gbc-mcp` 同样要加 `--package`）。

## 0.2.0 — 2026-11-10（行为变更已进入 main；`npm-v0.2.0` 未生成）


按 [CLI 评审](https://cursor.com/canvas/store-03b47b9f-5ab6-4503-9be6-9a3296edc4b3/be252665-9e58-42df-adcd-bd39bc629850) 和 [MCP 评审](https://cursor.com/canvas/store-03b47b9f-5ab6-4503-9be6-9a3296edc4b3/325ca93f-da93-4ca7-9ee6-b6d5c5a0ba59) 修复 agent 友好度问题。CLI 与 MCP 共用 `ops` 层，避免两套实现。

### Breaking

- **CLI 成功输出形状统一。** 以前 TTY 且未加 `--json` 时 stdout 只有 `data`，管道或 `--json` 时是完整 ResultEnvelope。现在两种终端都输出同一套封套（`schema_version` / `ok` / `data` / …）。TTY 未加 `--json` 时美化缩进；`--json` 或管道为紧凑 JSON。若仍只要 data，请改用 `--plain`。
- **未知 CLI flag 不再被忽略。** 例如 `--limt=5` 现在以退出码 2（`usage`）失败，并尽量提示相近旗标。sync 子命令本来就会拒绝未知 flag。
- **列表默认上限。** `message history`、`session list`、`sidebar list`（以及已有的 `bot list`）默认 `--limit=50`（最大 1000）。截断时结果带 `truncated`、`next`（可传回的 `--offset` / `offset`）和 `hint`。以前 `session list` / `sidebar list` 会返回全部条目；`message history` 会截断但不标记。
- **MCP 默认只读。** 写工具默认不出现在 `tools/list`。必须在宿主配置里设置 `GBT_ALLOW_WRITES=1` 或启动 `gbc-mcp --allow-writes`。只在工具参数里传 `allow_writes=true` 不再足够。`GBT_MCP_READONLY=1` 仍然隐藏 auth 变更工具，并且优先于写开关。sync 的 `sync_pull` / `sync_render` / `sync_attachments` 还需要 `GBT_SYNC_ALLOW_LOCAL_WRITES=1`。
- **MCP input schema 改为严格校验。** 未知参数会被拒绝（`additionalProperties: false` 与运行时一致）。无参数工具同样拒绝多余键。
- **分发改为 GitHub tag，不再发到 npmjs。** 安装应使用后来的 `npm-v0.2.1`（见上节）：`v0.2.0` 已推送，但发版工作流挂起，`npm-v0.2.0` 并未生成。正式 `npm-v*` tag 由推送 `v*` 后的 GitHub Actions 生成，不要从本机推送。npmjs 上的 0.1.3 已停止更新。

### 迁移

1. 依赖 TTY 下「只有 data、没有 `schema_version`」的脚本：加上 `--plain`，或改为解析完整封套（推荐 `--json`）。
2. 曾经带有拼写错误或额外 flag 仍能成功的脚本：删掉未知 flag，或改成合法名字。
3. 依赖 `session list` / `sidebar list` / `message history` 一次返回全部结果的调用：需要时提高 `--limit`，或用返回的 `next` 作为 `--offset` 继续取。
4. MCP 宿主：在配置中加入 `"GBT_ALLOW_WRITES": "1"` 或 args `--allow-writes`，否则模型看不到写工具。建议只给需要写的配置打开。
5. 若 MCP 调用曾发送额外字段，请按 `tools/list` 的 inputSchema 去掉它们。
6. 不要再使用 `npx grokbot-control@0.2.0` 或 `npm install grokbot-control@0.2.0`：该版本不会出现在 npmjs 上。改为 `github:...#npm-v0.2.1` 形式（`npm-v0.2.0` 因发版任务挂起而未生成）；私有仓库需先 `gh auth login` 或配置 SSH。

### 其他修复

- MCP 参数校验失败和未知工具现在返回 `isError` 加上与 CLI 相同的封套（`code` + `hint`），而不再只有纯文本 `-32602`。
- `interrupt_run` 与 `auth_logout` 的 `destructiveHint` 改为 true；`auth_whoami` / `sync_status` 的 `openWorldHint` 为 false。
- 服务器 `version` 与 package.json 对齐；成功结果注册了 ResultEnvelope 的 `outputSchema`。
- 文档与 `--help` 写清了输出约定、未知 flag、列表分页和 MCP 默认只读。
