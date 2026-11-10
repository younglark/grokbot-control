# Changelog

本文件记录公开包 `grokbot-control` 的用户可见变更。版本号遵循 SemVer。从 0.2.0 起通过 GitHub tag `npm-v<version>` 分发，不再发布到 npmjs。npmjs 上的 **0.1.3 已停止更新**。

## 0.2.0 — 2026-11-10（通过 GitHub tag `npm-v0.2.0` 分发，不发到 npmjs）

按 [CLI 评审](https://cursor.com/canvas/store-03b47b9f-5ab6-4503-9be6-9a3296edc4b3/be252665-9e58-42df-adcd-bd39bc629850) 和 [MCP 评审](https://cursor.com/canvas/store-03b47b9f-5ab6-4503-9be6-9a3296edc4b3/325ca93f-da93-4ca7-9ee6-b6d5c5a0ba59) 修复 agent 友好度问题。CLI 与 MCP 共用 `ops` 层，避免两套实现。

### Breaking

- **CLI 成功输出形状统一。** 以前 TTY 且未加 `--json` 时 stdout 只有 `data`，管道或 `--json` 时是完整 ResultEnvelope。现在两种终端都输出同一套封套（`schema_version` / `ok` / `data` / …）。TTY 未加 `--json` 时美化缩进；`--json` 或管道为紧凑 JSON。若仍只要 data，请改用 `--plain`。
- **未知 CLI flag 不再被忽略。** 例如 `--limt=5` 现在以退出码 2（`usage`）失败，并尽量提示相近旗标。sync 子命令本来就会拒绝未知 flag。
- **列表默认上限。** `message history`、`session list`、`sidebar list`（以及已有的 `bot list`）默认 `--limit=50`（最大 1000）。截断时结果带 `truncated`、`next`（可传回的 `--offset` / `offset`）和 `hint`。以前 `session list` / `sidebar list` 会返回全部条目；`message history` 会截断但不标记。
- **MCP 默认只读。** 写工具默认不出现在 `tools/list`。必须在宿主配置里设置 `GBT_ALLOW_WRITES=1` 或启动 `gbc-mcp --allow-writes`。只在工具参数里传 `allow_writes=true` 不再足够。`GBT_MCP_READONLY=1` 仍然隐藏 auth 变更工具，并且优先于写开关。sync 的 `sync_pull` / `sync_render` / `sync_attachments` 还需要 `GBT_SYNC_ALLOW_LOCAL_WRITES=1`。
- **MCP input schema 改为严格校验。** 未知参数会被拒绝（`additionalProperties: false` 与运行时一致）。无参数工具同样拒绝多余键。
- **分发改为 GitHub tag，不再发到 npmjs。** 安装使用 `npx -y --package=github:younglark/grokbot-control#npm-v0.2.0 gbc`（`gbc-mcp` 同样要加 `--package`）。正式 `npm-v*` tag 由推送 `v*` 后的 GitHub Actions 生成，不要从本机推送。npmjs 上的 0.1.3 已停止更新。

### 迁移

1. 依赖 TTY 下「只有 data、没有 `schema_version`」的脚本：加上 `--plain`，或改为解析完整封套（推荐 `--json`）。
2. 曾经带有拼写错误或额外 flag 仍能成功的脚本：删掉未知 flag，或改成合法名字。
3. 依赖 `session list` / `sidebar list` / `message history` 一次返回全部结果的调用：需要时提高 `--limit`，或用返回的 `next` 作为 `--offset` 继续取。
4. MCP 宿主：在配置中加入 `"GBT_ALLOW_WRITES": "1"` 或 args `--allow-writes`，否则模型看不到写工具。建议只给需要写的配置打开。
5. 若 MCP 调用曾发送额外字段，请按 `tools/list` 的 inputSchema 去掉它们。
6. 不要再使用 `npx grokbot-control@0.2.0` 或 `npm install grokbot-control@0.2.0`：该版本不会出现在 npmjs 上。改为上面的 `github:...#npm-v0.2.0` 形式；私有仓库需先 `gh auth login` 或配置 SSH。

### 其他修复

- MCP 参数校验失败和未知工具现在返回 `isError` 加上与 CLI 相同的封套（`code` + `hint`），而不再只有纯文本 `-32602`。
- `interrupt_run` 与 `auth_logout` 的 `destructiveHint` 改为 true；`auth_whoami` / `sync_status` 的 `openWorldHint` 为 false。
- 服务器 `version` 与 package.json 对齐；成功结果注册了 ResultEnvelope 的 `outputSchema`。
- 文档与 `--help` 写清了输出约定、未知 flag、列表分页和 MCP 默认只读。
