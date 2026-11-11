# Changelog

本文件记录公开包 `grokbot-control` 的用户可见变更。版本号遵循 SemVer。从 0.2.0 起通过 GitHub tag `npm-v<version>` 分发，不再发布到 npmjs。npmjs 上的 **0.1.3 已停止更新**。

## Unreleased

## 0.4.0 — 2026-11-11（通过 GitHub tag `npm-v0.4.0` 分发，不发到 npmjs）

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

安装：`npx -y --package=github:younglark/grokbot-control#npm-v0.4.0 gbc`（`gbc-mcp` 同样要加 `--package`）。

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
