# 实施分期（每期 CLI+MCP 同步）

不实现本轮。原始功能不得静默缩水。

| 阶段 | 内容 | 出口（另授真机后） |
|---|---|---|
| **S0** | 鉴权 bootstrap；0.78.4↔0.79.2；Create/Sidebar 冲突码；session 默认规则 | 只读+创建字段矩阵实测记录 |
| **S1** | bot CRUD + auth whoami；dry-run/confirm；toolsets | App 级 bot 管理可编程 |
| **S2** | message send/status/history；session；progress+interrupt；outcome=unknown 路径 | 主对话闭环 |
| **S3** | sidebar sections patch+verify+conflict；Room 独立命令（可选启用） | 分组读回验证通过 |

**P1 可选：** Watch 封装、toolset 细拆、HTTP MCP、观测辅助——不挡 S1–S2。

**每期测试：** MCP/CLI 参数语义等价；无 TTY/JSON；mock 仅离线；真机用独立 test bot。
