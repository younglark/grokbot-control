# grokbot-control

围绕 Grok Bot 桌面 App（目标版本 **0.79.3**）的非官方工程仓库。协议与行为全部来自对官方 App 的**静态**逆向，不是公开 API。

## 三个目标

| # | 目标 | 代码 | 状态 |
|---|---|---|---|
| 1 | **控制面**：SDK + CLI `gbc` + MCP `gbc-mcp`，让 agent 用原生 Connect RPC 驱动 Bot | [packages/grokbot-control](packages/grokbot-control/README.md) | 通过 GitHub tag `npm-v0.3.0` 安装（`npx -y --package=github:younglark/grokbot-control#npm-v0.3.0 gbc`）；npmjs 上的 `grokbot-control@0.1.3` 已停止更新。部分只读 RPC 做过 live 验证 |
| 2 | **`local-exec-daemon` 兼容替代**：与 App 0.79.3 托管的官方 daemon 行为一致（包名/bin 就叫 `local-exec-daemon`，不加 `-compat`） | [packages/local-exec-daemon](packages/local-exec-daemon/README.md) | private；Linux 可达路径已按原版移植并通过合成验收；**不是**无条件 drop-in |
| 3 | **无头注册**本地电脑 / Docker | [docs/headless](docs/headless/README.md) | 仅设计，未实现（下一阶段） |

接手请先读 **[docs/HANDOFF.md](docs/HANDOFF.md)**（现状、未完成项、风险、工作约定、下一步）。

## 快速开始

需要 Node ≥ 20、Python 3。仓库根是唯一的 npm workspace 和唯一的 lock。

```bash
npm ci
export UC_SKIP_OFFICIAL=1        # 必须：任何测试都不得运行官方二进制
npm run generate:check           # 生成代码与冻结协议逐字节一致
npm run build
npm test                         # control + daemon + 仓库边界测试
npm run test:protocol-tools      # tools/protocol 的 Python 单测
```

试用 CLI（mock，离线）：`npm run dev:gbc -- --mock --json bot list`。
安装已发布的控制面（私有仓库需先完成 GitHub 认证）：`npx -y --package=github:younglark/grokbot-control#npm-v0.3.0 gbc --help`。
测试分层、门控验收、Electron、打包与 GitHub 发版见 [docs/development.md](docs/development.md)。

## 目录地图

```text
packages/
  grokbot-control/     公开包：SDK / CLI / MCP（ESM）
  local-exec-daemon/   私有包：daemon 兼容实现（TS → CJS）
  protocol/            私有构建工具：冻结 .proto + 唯一代码生成器（不是运行时依赖）
  headless-node/       占位：无头宿主设计位置（无代码）
deploy/headless/       占位：未来 Docker 部署文档（无 Dockerfile）
tools/protocol/        离线协议还原/校验脚本（Python + 一个 Node 校验器）
scripts/verify-package.mjs   真实打包 + 隔离安装检查
scripts/release-github.mjs   本地预览 GitHub 安装树（默认不打、不推官方 npm-v* tag）
test/organization.test.mjs   跨包边界与文档链接测试
docs/                  全部文档（见下）
```

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/HANDOFF.md](docs/HANDOFF.md) | 交接：完成/未完成、风险、约定、下一步 |
| [docs/development.md](docs/development.md) | 开发、测试分层、安全规则、发布 |
| [docs/architecture.md](docs/architecture.md) | 仓库结构、包边界、协议生成链路 |
| [docs/protocol/](docs/protocol/README.md) | 冻结协议、App 更新后如何重新还原 |
| [docs/control-plane/](docs/control-plane/README.md) | 控制面需求、架构、鉴权锁、同步格式、实现状态 |
| [docs/local-exec/](docs/local-exec/README.md) | daemon 总览、差异表、验收矩阵、单点证据 |
| [docs/headless/](docs/headless/README.md) | 无头注册设计边界 |
| [docs/history/](docs/history/README.md) | 历史过程记录（附录，非当前状态） |
| [docs/README.md](docs/README.md) | 完整文档目录 |
