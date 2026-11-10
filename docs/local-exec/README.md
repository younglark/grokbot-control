# local-exec：本地执行 daemon 的兼容文档

实现：[packages/local-exec-daemon](../../packages/local-exec-daemon/README.md)（私有包，包名和 bin 名都是 `local-exec-daemon`）。
目标：行为上与 App **0.79.3** 原版 local-exec-daemon 一致。当前做到的是合成/离线环境下的验证，**不是**正式安装替换，也不是完整 drop-in。公开 npm 的 Electron 45 烟测不等于 App 内置 Electron 42 的验收。

## 边界

- Node IPC / Electron parentPort 是 App 托管时的入口；UC/Box 执行语义归 daemon 所有。
- 将来的 headless host 以**进程**方式监督 daemon，不把 CLI/MCP 引进 daemon（[headless 设计](../headless/README.md)）。共享 schema/codegen 不代表共享凭据或权限状态。
- "Box" 指 local-exec 的 Box JSON/SSE 控制通道（`BoxProvider`），**不是** Box.com。

## D: / W: 行号从哪里来

- **D:** = `/workspace/grokbot-node-analysis-0793/daemon.formatted.cjs` 的行号：官方 `dist/local-exec-daemon/main.cjs`（sha256 `5c1424ed…36be`）经 prettier 格式化后的文本，187 625 行，sha256 `ad69a772…684c`。不入库，只读，不执行。
- **W:** = 同一 asar 中 `messages-worker.cjs` 的格式化副本（sha256 `b6f5c672…667b`）。
- App 升级后如何重新生成并重新锚定，见 [protocol/update-runbook.md](../protocol/update-runbook.md) §5。

## 主文档

| 文档 | 内容 |
|---|---|
| [overview.md](overview.md) | **先读这个**：daemon 在 App 中的角色、职责边界、已移植能力、有意不移植的项、源码地图 |
| [remaining-diffs.md](remaining-diffs.md) | 与原版差异总表（逐项根因与状态） |
| [dropin-acceptance.md](dropin-acceptance.md) | 48 步替换验收矩阵和两个门控 harness（被测试代码引用） |
| [port-coverage.md](port-coverage.md) | 函数级移植覆盖审计、Sentry 方案、不可达核验（被代码注释引用） |
| [scenario-matrix.md](scenario-matrix.md) | App 启动静态对照、官方 oracle 差分、shell 场景矩阵（被代码注释引用） |

## 单点证据

`evidence/` 下每个文件对应一个机制：原版 D: 行号 → 我们的实现 → 测试。新发现的差异照此格式新建 `evidence/<主题>.md`，并在 [remaining-diffs.md](remaining-diffs.md) 加一行。

| 主题 | 文件 |
|---|---|
| Box 通道 | [box-connection](evidence/box-connection.md)、[box-hello](evidence/box-hello.md)、[box-upload](evidence/box-upload.md)、[box-messages-op](evidence/box-messages-op.md)、[connection-exchange](evidence/connection-exchange.md) |
| UC 通道 | [uc-transport-hello](evidence/uc-transport-hello.md)、[uc-unauthorized-renewal](evidence/uc-unauthorized-renewal.md)、[uc-download](evidence/uc-download.md)、[uc-messages-op](evidence/uc-messages-op.md)、[upload-box-url](evidence/upload-box-url.md) |
| 执行与关停 | [close-stream](evidence/close-stream.md)（Ki 通道、取消顺序）、[ls-ripgrep](evidence/ls-ripgrep.md)、[cp-write](evidence/cp-write.md) |
| 审批与工具 | [standing-grants](evidence/standing-grants.md)、[local-tools](evidence/local-tools.md)、[obsidian](evidence/obsidian.md)、[discover-ai-tool](evidence/discover-ai-tool.md) |
| 生命周期 | [ownership-oracle](evidence/ownership-oracle.md)（ownership 调度与保留的发布竞态） |

逐轮审查、集成和过程记录在 [docs/history/](../history/README.md)。
