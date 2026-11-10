# local-exec-daemon

独立实现的本地执行 daemon，目标是与 Grok Bot App **0.79.3** 的原版 local-exec-daemon 行为一致。私有包（`UNLICENSED`，不发布），bin `local-exec-daemon` → `dist/index.js`。

**不是**官方二进制，**还不能**原位替换 App 安装；开发时**不要**连接真实账户的控制面。

- 设计、职责边界、能力清单：[docs/local-exec/overview.md](../../docs/local-exec/overview.md)
- 与原版差异总表：[docs/local-exec/remaining-diffs.md](../../docs/local-exec/remaining-diffs.md)
- 单点证据（D: 行号）：[docs/local-exec/README.md](../../docs/local-exec/README.md#单点证据)

## 命令

在仓库根目录 `npm ci` 一次（只有根 lock）。所有测试命令前先 `export UC_SKIP_OFFICIAL=1`，否则会运行离线实验室里的官方 main.cjs。

```bash
export UC_SKIP_OFFICIAL=1
npm run build -w local-exec-daemon
npm test -w local-exec-daemon            # build + node --test test/*.test.cjs
npm run smoke:uc                          # 合成 UC peer 烟测
LOCAL_EXEC_DAEMON_ELECTRON=/path/to/npm/electron npm run smoke:electron   # 公开 npm Electron，未设置则跳过
npm run generate:check                    # 生成代码与冻结 schema 是否一致
```

门控验收 harness（48 步矩阵）、测试分层与耗时见 [docs/development.md](../../docs/development.md)。

## 运行时环境变量（测试中一律用合成值）

| 变量 | 作用 |
|---|---|
| `SAND_DATA_ROOT` / `SAND_USER_DATA_DIR` | settings、discovery、connection、密封凭据、lease 所在目录 |
| `SAND_LOCAL_EXEC_ROOT` → `SAND_AGENT_PROJECT_DIR` → `homedir()` | 路径守卫的根 |
| `SAND_LOCAL_EXEC_GENERATION` | 写入 discovery 的 generation（daemon 不据此退出，与原版相同） |
| `SAND_NODE_PROXY_ENV` | 启动时代理设置，discovery 带 proxyFingerprint |
| `SAND_DISABLE_TELEMETRY=1` | 关闭遥测 |

## 源码地图

```
src/
  index.ts          入口：handoff → discovery → Box / UC 生命周期、ownership
  bootstrap/        crash-guard、handoff（IPC / parentPort）、boot-env
  settings.ts       settings 全 schema 与 damaged/unsupported 日志
  state/            discovery、connection(+exchange)、lease、fs-write（cp）、node-proxy、standing-signals
  exec/             handlers、shell-session、background-shell、denylist、sandbox、ls-ripgrep、spawn-workload、output-channel（Ki）、exec-codec
  box/              Box SSE provider、messages-op
  uc/               provider（Watch/Poll/Submit/Withdraw）、reply-lanes、approvals、credential、sealed、file-source、local-tools、obsidian、outage-ledger、ai-tool-discovery
  transport/        replies
  generated/        由冻结 schema 生成的 protobuf-es + Connect 代码（不要手改，跑 npm run generate）
scripts/            uc-smoke、electron-smoke、oracles/（研究用对照 harness，不属于常规测试）
test/               node:test；文件名 tNNN-* 是历史编号
```

## 依赖

运行时精确锁定：`@bufbuild/protobuf` / `@connectrpc/connect` / `@connectrpc/connect-node` 1.6.1（与 App 一致）、`zod` 3.25.76、`tree-sitter` 0.21.1、`tree-sitter-bash` 0.21.0（denylist 解析，公开 npm，需原生构建）。`npm audit` 有 zod 和 connect-node 传递依赖（undici、@fastify/busboy）的已知告警，修复需要跨大版本，尚未升级，见 [docs/HANDOFF.md](../../docs/HANDOFF.md) 风险一节。

## 安全

- 测试只用合成凭据；`Buffer.alloc(32, 7)` 这类固定 key 和 `synthetic` 前缀凭据是公开的测试数据。
- 不提交真实 key、cookie、账户 token；不运行官方 main.cjs、worker、App 二进制。
- 来源与许可边界见 [NOTICE.md](NOTICE.md)。
