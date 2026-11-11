# 控制面：SDK / CLI / MCP

实现：[packages/grokbot-control](../../packages/grokbot-control/README.md)。公开包名 `grokbot-control`，bin `gbc` / `gbc-mcp`，SDK 导出不变。鉴权、业务操作、同步/附件、原生鉴权锁和 CLI/MCP 共享语义都在这一个包里，不拆微包，不引入强制 task 层。

| 文档 | 内容 |
|---|---|
| [requirements.md](requirements.md) | 产品定义、核心能力、非目标、验收场景 |
| [architecture.md](architecture.md) | 模块、结果契约、退出码、写安全、进展模型 |
| [implementation-status.md](implementation-status.md) | 已实现、live 验证范围、未验证项 |
| [auth-lock.md](auth-lock.md) | 原生跨进程刷新锁（路径被代码里的错误提示引用，不要移动） |
| [sync-format.md](sync-format.md) | 文件归档格式、分页/backfill、附件与正文补读 |
| [../protocol/protocol-map.md](../protocol/protocol-map.md) | App 动作 ↔ RPC ↔ SDK/CLI/MCP 契约 |
| [../protocol/auth-flow.md](../protocol/auth-flow.md) | 登录/刷新协议证据 |

单包命令：`npm test -w grokbot-control`、`npm run dev:gbc -- --mock --json bot list`、`npm run dev:gbc -- dashboard --mock`。

`gbc dashboard` 是本地回环上的只读 Bot 监视器（轮询 + SSE），与官方 protobuf `DashboardService` 不是同一件事。第一期只封装只读的 `GetSandUsageStatus`，不提供 MCP 工具，也不暴露官方写 RPC。
