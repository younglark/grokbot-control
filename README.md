# grokbot-control

## 产品定义（首要）

**正常情况：人通过 Grok Bot App 驱动 Bot。**  
**目标：变成 agent CLI 通过 MCP / CLI 驱动同一套 Grok Bot。**

本项目提供**可编程控制面**，等价覆盖 App 里人对 Bot 的操作入口（创建/管理、发消息、看进展、分组等），供上层 agent CLI（Grok Build / OpenCode / Codex 等）在拆分需求后调用。

| 是 | 不是 |
|---|---|
| App 操作的可编程替代入口 | 另建一套自有「任务系统 / 账本 / 守护进程」作为一切前提 |
| 尽量保留原生 bot / session / message 语义，直接映射 RPC | 强制 `task submit` 才能发消息 |
| MCP **与** CLI（示意名 `gbc`，未定）同步支持 | 替代上层会话式 coding agent |
| 覆盖用户明确的基础 App 能力；其它按产品域扩展 | 全量导出 607 个 RPC；Admin/Internal/Vault 秘密 |

> 还原 Schema（`grokbot-proto`）≠ 官方开放 API。  
> **本仓库当前仅规划文档，无实现。未做真实登录或线上读写。**

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/requirements.md](docs/requirements.md) | 需求订正、App→控制面范围追踪、与旧 task-bridge 切割 |
| [docs/protocol-map.md](docs/protocol-map.md) | App 能力 / CLI / MCP → RPC（49fd8ce） |
| [docs/architecture.md](docs/architecture.md) | 共享 SDK + 双薄适配；任务聚合可选 |
| [docs/implementation-plan.md](docs/implementation-plan.md) | 分期 S0–S3（每期 CLI+MCP 同进） |
| [docs/acceptance.md](docs/acceptance.md) | 「App 能做 → MCP/CLI 等价」验收 |

## 与旧仓库

- [younglark/grokbot-task-bridge](https://github.com/younglark/grokbot-task-bridge) **保留**，仅参考，**非**当前交付。
- 不复制旧实现；纠正「自建 task 桥替代 bot CRUD」的偏离。

## 协议基线

- `grokbot-proto` @ `49fd8ce` / APP **0.78.4**
- 运行包常见 **0.79.2**（兼容须另验）

## 状态

2026-11-07（Asia/Shanghai）：仅文档规划。
