# 实现状态（本地，2026-11-07 Asia/Shanghai）

| 能力 | CLI | MCP | Connect | 测试 | Live |
|---|---|---|---|---|---|
| bot create (Temporal) | ✅ | ✅ create_bot | ✅ | ✅ mock+schema | ❌ 未验 |
| bot list/get(list筛) | ✅ | ✅ | ✅ | ✅ | ❌ |
| bot update/delete+confirm+dry-run | ✅ | ✅ | ✅ | ✅ | ❌ |
| message send（无 task id） | ✅ | ✅ | ✅ | ✅ | ❌ |
| send status / history / sessions | ✅ | ✅ | ✅ | ✅ | ❌ |
| progress status/todos/tasks/subagents/interrupt | ✅ | ✅ | ✅ | ✅ mock | ❌ |
| SidebarSections CRUD/move + base | ✅ | ✅ | ✅ | ✅ conflict | ❌ |
| Room | unsupported | — | — | — | — |
| Auth login-begin/complete/poll/refresh/logout（证据驱动，静态逆向） | ✅ | ✅ login_begin/complete/cancel/logout | ✅ | ✅ fake fetch + 本地 fake 后端跨进程 | ✅ 真实浏览器登录 + 只读 RPC（bot list/sidebar list/status）一次人工验证；❌ refresh（需配置 client_id）与写操作未 live 验 |
| unknown 丢响应 / 不盲重试 | ✅ | ✅ | ✅ | ✅ | — |

`simulated: true` 仅 mock。

协议 vendor：App **0.79.3**（2026-11-07 本仓库从App恢复生成）。上表 Live ✅ 一行是在**旧 0.78.4 vendor** 下完成的；0.79.3 vendor 仅离线验证（`verify_generated.mjs` + `test/proto-vendor-contract.test.ts`），未 live 调用。0.79.x 新增字段未暴露到 SDK/CLI/MCP。
