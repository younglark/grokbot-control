# 文档索引

先读 [HANDOFF.md](HANDOFF.md)（现状、未完成、风险、约定），再读 [development.md](development.md)（怎么构建、测试、改文档）。

```
docs/
  HANDOFF.md                交接：现状、未完成项、风险、工作约定、外部材料
  development.md            开发指南：环境、命令、测试分层、文档放置规则、CI、发布
  architecture.md           仓库架构：包依赖、组织测试约束、协议生成流水线、源码地图
  control-plane/            控制面（grokbot-control：SDK / CLI / MCP）
  protocol/                 协议归档、静态还原方法、App 更新 runbook、RPC 契约
  local-exec/               本地执行 daemon 兼容（overview、差异总表、验收矩阵）
    evidence/               单点证据：一个机制一个文件，带 D: 行号
  headless/                 headless 宿主设计（未实现）
  history/                  过程记录附录（不代表当前状态）
```

| 目录 | 入口 |
|---|---|
| 控制面 | [control-plane/README.md](control-plane/README.md) |
| 协议 | [protocol/README.md](protocol/README.md)；App 更新后：[protocol/update-runbook.md](protocol/update-runbook.md) |
| 本地执行 | [local-exec/README.md](local-exec/README.md) → [overview.md](local-exec/overview.md) |
| headless | [headless/README.md](headless/README.md) |
| 历史 | [history/README.md](history/README.md) |

## 不能随便移动的路径

| 路径 | 原因 |
|---|---|
| `docs/headless/README.md` | `test/organization.test.mjs` 要求存在 |
| `docs/control-plane/auth-lock.md` | CLI 帮助、`src/auth/lock.ts` 错误提示和测试里写了这个 URL |
| `docs/protocol/baseline-manifest.md` | 冻结 schema 的 README 链接到它（冻结 README 有哈希校验，不能改） |
| `docs/protocol/transcript-body-0.79.3.md` | `src/sync/decode.ts` 和 fixture 引用 |
| `docs/local-exec/{dropin-acceptance,port-coverage,scenario-matrix}.md`、`evidence/*.md` | daemon 源码注释和测试引用 |

移动文档后运行 `node --test test/organization.test.mjs`（会检查所有 .md 相对链接），并用 `rg` 查源码注释里的旧路径。
