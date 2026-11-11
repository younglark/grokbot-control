# 控制面实现状态

协议基线 App 0.79.3（vendor 由本仓库从 App 还原生成）。各轮实现细节和 live 验收原始记录见 [history/control-plane-status-log.md](../history/control-plane-status-log.md)。

## 已实现

| 模块 | 要点 |
|---|---|
| bot / message / session / progress / computer / sidebar | 见 [surface-map.md](../protocol/surface-map.md) 和 [protocol-map.md](../protocol/protocol-map.md)；update/delete 经 List 把 UUID 映射到服务端 id；默认会话用空 session_id |
| 写安全 | 远端写需 `--allow-writes` / `GBT_ALLOW_WRITES=1`；危险操作需 `--confirm=<id>`；写失败不确定时 `outcome=unknown`（exit 10），**从不自动重发** |
| 鉴权 | 独立 Cursor 浏览器登录（默认 `cli`）；可选 `bot` 登录模式只改变 `loginDeepControl` URL（`sand` + `supportsSelectedTeamLogin=true`），凭据仍在 `~/.gbc`，不读 App 凭据、不猜 team id、不伪造官方头；凭据带 provenance / revision / session 绑定；`client_id` 只来自 `GBT_OAUTH_CLIENT_ID` 或登录时持久化，不内置不猜；临期 < 300 s 刷新；进程内 singleflight + 原生跨进程锁（[auth-lock.md](auth-lock.md)）；RPC 401 只对只读白名单刷新重试一次 |
| 同步 `sync pull/status/render/attachments` | 文件归档（无 SQLite）、head 刷新与 backfill 分离、预算与轮转、附件按需下载（仅已证实的 store alias）、可选 `--hydrate missing` 正文补读；格式与限制见 [sync-format.md](sync-format.md) |
| MCP | 与 CLI 共用 SDK；默认只注册只读业务工具和 auth；写工具需 `GBT_ALLOW_WRITES=1` 或 `--allow-writes` 才出现在 `tools/list`；`GBT_MCP_READONLY=1` 更严并优先；input schema 严格拒绝未知参数；stdout 只有 JSON-RPC |
| 本地监视器 `gbc dashboard` | 回环只读近实时监视页（本地轮询 + SSE，不是 Watch 流）。CLI 命令，不是官方 `DashboardService`；第一期只封装只读 `GetSandUsageStatus`（空请求），无 MCP 工具，不暴露官方写 RPC。未登录也可启动，页面提示在终端登录。默认 `127.0.0.1`，v1 拒绝非回环 `--host` |

## live 验证范围（2026-11-07，隔离测试 bot，结束后已删除）

- 通过：浏览器登录（`redirectTarget=cli`）→ `/auth/poll`；只读 `ListGrokBotAgents`、`GetGrokBotUserRuntimeSettings`、`ListGrokBotAgentStatuses`（只带 Bearer）。这三个当时用的是旧 0.78.4 vendor。
- 通过：create 临时 bot → send 一条固定测试消息 → 默认会话分页拉取 → send-message 附件下载（中文文件名、条件 GET 304）→ CLI status/render、MCP 只读 `sync_status` → 删除临时 bot（前后 bot 集合一致）。
- 未触发：omitted / blob 正文补读（真实服务没有返回这类条目），命名 session。

2026-11-11：可选 bot 登录（`--login-mode bot`，`redirectTarget=sand` + `supportsSelectedTeamLogin=true`）→ `/auth/poll` 收束，得到 Cursor token（kind `cursor`，backend api2）。未验证选中团队如何返回/是否需要 `x-cursor-team-id`，以及该模式之后的 OAuth 刷新。

## 未验证 / 未实现（不得扩大声称）

- OAuth 刷新从未 live 执行；所有写 RPC 的边界语义（`id` vs `agent_id`、sidebar 冲突错误码、写是否需要 App 头）未 live 验证，清单见 [compat-matrix.md](../protocol/compat-matrix.md)。
- 可选 bot 登录的选中团队如何返回/是否需要 `x-cursor-team-id`、以及该模式下的刷新仍未 live 验证；不能推断团队已绑定。
- user-attachment 上传、URL 403/过期、下载超限、代际切换未 live 执行。
- 未实现：Watch / deletes / cursorTooOld 实时补偿、chunk 读取兜底、artifact / 外链下载。
- 本地 `gbc dashboard`：`computer.state` 未经实时核验；`usage_percent` 单位未经 live 核实；企业用量拆分 / `GetGrokBotUsageBreakdown` 与需要已核实 team_id 的额度 RPC 留到后续阶段；OAuth 刷新仍未 live 核实。
- 同步的 completeness 永远是 `unknown`；账户身份是操作者声明（`operator_asserted_unverified`），不是服务端验证。
- macOS / Windows 的原生锁只做了源码与预编译包检查和 CI 配置，未在本机运行。
