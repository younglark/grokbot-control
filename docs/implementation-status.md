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
| Auth begin/poll/refresh（注入 fetch） | 部分 | whoami | — | ✅ fake fetch | ❌ 真实登录未做 |
| unknown 丢响应 / 不盲重试 | ✅ | ✅ | ✅ | ✅ | — |

`simulated: true` 仅 mock。Live 列始终未验证。
