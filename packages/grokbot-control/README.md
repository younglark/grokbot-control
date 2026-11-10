# grokbot-control

**人通过 Grok Bot App 驱动 → agent CLI 经 MCP / CLI 驱动同一 Bot。**

可编程控制面（原生 Connect RPC），不是另建任务系统。CLI 入口 **`gbc`**，MCP stdio 入口 **`gbc-mcp`**。当前 npm 版本 **0.1.3**。

> 非官方产品。协议来自 Grok Bot 桌面 App 的静态逆向，**不是**公开 API。自动化测试以 mock 为主；部分选定 RPC 曾做过隔离 live 验收，范围见 [docs/control-plane/implementation-status.md](https://github.com/younglark/grokbot-control/blob/main/docs/control-plane/implementation-status.md)，不能据此推定全部 RPC / OAuth 刷新已验证。

## Why

App 里能做的 Bot 生命周期、发消息、侧边栏、进度与中断，希望由上层 agent / 脚本以同一后端能力完成，而不是再造一套 task 状态机。

## Features

- **Bot**：create / list / get（list 筛选）/ update / delete
- **电脑**：state、reset（`preserve_data:false`）、`--hard`、`--wait` 阶段进度
- **消息与会话**：send、send status、history、sessions
- **侧边栏**：SidebarSections CRUD、移动成员（删除分组 ≠ 删除 Bot）
- **进度**：status、原生 todos / tasks / subagents、interrupt
- **鉴权**：独立 Cursor 浏览器登录；凭据存 `~/.gbc`（0600）；不读取 App 的 `sand-secrets.json`
- **文件同步**：`sync pull|status|render|attachments`（无 SQLite；细节见 [docs/control-plane/sync-format.md](https://github.com/younglark/grokbot-control/blob/main/docs/control-plane/sync-format.md)）
- **双入口**：同一 shared SDK → CLI（`gbc`）与 MCP（`gbc-mcp`）
- **写安全**：远端写需 `--allow-writes`；危险操作需 `--confirm=<id>`；`--dry-run` 纯本地计划

## Install

需要 **Node.js ≥ 20**。

### npx（推荐）

```bash
npx --yes --package=grokbot-control@0.1.3 gbc --help
npx --yes --package=grokbot-control@0.1.3 gbc --mock --json bot list
npx --yes --package=grokbot-control@0.1.3 gbc-mcp
```

也可用 `@latest`；MCP 建议钉版本，避免宿主静默升级。

### 全局安装

```bash
npm install --global grokbot-control@0.1.3
gbc --help
gbc-mcp
```

### 从源码

```bash
git clone https://github.com/younglark/grokbot-control.git
cd grokbot-control
npm ci
npm run build
npm test
node packages/grokbot-control/dist/cli/main.js --help
```

## Quick start

### Mock（离线仿真）

结果带 `simulated: true`，不是在线成功。跨进程状态：`GBT_MOCK_STATE` 或 `~/.gbc/mock-state.json`。

```bash
npx --yes --package=grokbot-control@0.1.3 gbc --mock --json --allow-writes \
  bot create --name demo --description "test"
npx --yes --package=grokbot-control@0.1.3 gbc --mock --json bot list
npx --yes --package=grokbot-control@0.1.3 gbc --mock --json --allow-writes \
  message send --agent-id <id> --session-id <sid> --text "hello"
npx --yes --package=grokbot-control@0.1.3 gbc --mock --json bot status --agent-id <id>
```

### Live（真实后端）

默认 backend `https://api2.cursor.sh`，网站 `https://cursor.com`。不要设置 `GBT_MOCK`。

```bash
gbc --json auth login --timeout 300
# URL 走 stderr 的 open_browser 事件；也可分步：
#   gbc --json auth login-begin
#   gbc --json auth complete --timeout 300

gbc --json auth whoami          # 离线本地状态，不打印 token
gbc --json bot list --limit 20  # 只读
gbc --json computer state       # 只读
gbc --json --allow-writes computer reset --confirm=RESET_COMPUTER --wait --timeout 600
gbc --json sidebar list
gbc --json auth logout          # 只删本工具本地凭据，不吊销服务端会话
```

Token 刷新需自行配置公开的 `GBT_OAUTH_CLIENT_ID`（本工具**不内置**，也不从 JWT 猜测），或登录时已持久化的绑定。详见下方 Auth。

## MCP 配置

stdio；**stdout 仅协议帧**，不要把 CLI 日志打到 stdout。

```json
{
  "mcpServers": {
    "grokbot-control": {
      "command": "npx",
      "args": ["--yes", "--package=grokbot-control@0.1.3", "gbc-mcp"],
      "env": {
        "GBT_OAUTH_CLIENT_ID": "<your-public-oauth-client-id>"
      }
    }
  }
}
```

常用环境变量：

| 变量 | 说明 |
|---|---|
| `GBT_MCP_READONLY=1` | 仅 `auth_whoami` + 只读业务工具（不含 login/logout/cancel/refresh 及写工具） |
| `GBT_ALLOW_WRITES=1` | 允许远端写工具 |
| `GBT_OAUTH_CLIENT_ID` | 公开 OAuth client id（刷新用；不内置） |
| `GBT_CREDENTIALS_DIR` | 凭据目录，默认 `~/.gbc` |
| `GBT_SYNC_ROOT` | 设置后才提供 `sync_status` |
| `GBT_SYNC_ALLOW_LOCAL_WRITES=1` | 另需才提供 `sync_pull` / `sync_render` / `sync_attachments` |
| `GBT_SYNC_ACCOUNT_ID` / `GBT_SYNC_TEAM_ID` / `GBT_SYNC_ACK_UNVERIFIED_SCOPE=1` | sync pull 作用域（操作者声明，非服务端验证） |

只读试跑：

```bash
GBT_MCP_READONLY=1 npx --yes --package=grokbot-control@0.1.3 gbc-mcp
```

主要工具：`list_bots`、`get_bot`、`create_bot`、`update_bot`、`delete_bot`、`get_computer_state`、`reset_computer`、`send_message`、`get_send_status`、`list_transcript`、`list_sessions`、`get_bot_status`、`list_agent_todos`、`list_agent_tasks`、`list_agent_subagents`、`interrupt_run`、sidebar 系列、`auth_*`、可选 `sync_*`。完整契约见 [docs/protocol/protocol-map.md](https://github.com/younglark/grokbot-control/blob/main/docs/protocol/protocol-map.md)。

## Auth

独立 Cursor 浏览器登录（静态逆向协议，非官方公开 API）。仅支持 Cursor token；xAI identity 返回 `unsupported`。

| 命令 | 作用 |
|---|---|
| `gbc --json auth login-begin` | 输出 `authorization_url`（不含 verifier） |
| `gbc --json auth complete --timeout 300` | 轮询 `/auth/poll`；成功后写入 `~/.gbc`（0600） |
| `gbc --json auth login --timeout 300` | begin + complete；URL 经 stderr |
| `gbc --json auth whoami` | 离线本地状态，不联网、不打印 token |
| `gbc --json auth refresh [--force]` | 临期 / 缺非法 exp / `--force` 才刷新 |
| `gbc --json auth logout` | 只删本工具本地凭据 |

要点：

- **不内置 `client_id`**；刷新依赖 `GBT_OAUTH_CLIENT_ID` 或登录持久化绑定。旧凭据可用 `GBT_AUTH_CONFIRM_MIGRATE=1` 确认迁移。
- 凭据独立于 App；logout 不吊销服务端会话。
- 跨进程 refresh 使用原生 OS advisory lock（`fs-native-extensions`）；缺失 binding 则 fail closed。升级前请停止全部旧 MCP 进程。详见 [docs/control-plane/auth-lock.md](https://github.com/younglark/grokbot-control/blob/main/docs/control-plane/auth-lock.md)。
- 协议与证据：[docs/protocol/auth-flow.md](https://github.com/younglark/grokbot-control/blob/main/docs/protocol/auth-flow.md)、[docs/protocol/protocol-map.md](https://github.com/younglark/grokbot-control/blob/main/docs/protocol/protocol-map.md)。

示例环境变量见 [.env.example](.env.example)。

## CLI 概览

```text
gbc [--json] [--mock] [--allow-writes] [--dry-run] [--base-url URL] [--auth-kind cursor|xai] <noun> <verb> [flags]
```

| 名词 | 动词（摘要） |
|---|---|
| `auth` | `login-begin` / `complete` / `login` / `whoami` / `poll` / `cancel` / `refresh` / `logout` |
| `bot` | `create` / `list` / `get` / `update` / `delete` / `status` / `todos` / `tasks` / `subagents` / `interrupt` |
| `computer` | `state` / `reset`（`--hard`、`--wait`、`--timeout`） |
| `message` | `send` / `status` / `history` |
| `session` | `list` |
| `sidebar` | `list` / `create` / `rename` / `delete` / `move` |
| `sync` | `pull` / `status` / `render` / `attachments` |

危险写操作（`bot delete`、`sidebar delete`、`interrupt` 等）需要 `--confirm=<resource-id>` 精确匹配。`computer reset` 使用固定 token `--confirm=RESET_COMPUTER`，会重建共享电脑且启动后不可取消；`--hard` 走 `ForceRecreateSandBox`。远端写需要 `--allow-writes` 或 `GBT_ALLOW_WRITES=1`；`sync` 的本地归档写由命令本身授权，不要求远端 `--allow-writes`。

### 退出码

| 码 | 含义 |
|---:|---|
| 0 | success |
| 2 | usage |
| 4 | auth |
| 5 | not_found |
| 6 | conflict |
| 7 | denied |
| 8 | retryable |
| 9 | known_failure |
| 10 | unknown outcome（写后无法排除副作用时勿盲目重试） |
| 1 | other |

统一 JSON 结果契约见 [docs/control-plane/architecture.md](https://github.com/younglark/grokbot-control/blob/main/docs/control-plane/architecture.md)。

### Sync（摘要）

```bash
gbc sync pull --agent-id <id> --dir /absolute/private/root \
  --account-id <stable-id> --team-id none --ack-unverified-scope
gbc sync status --dir /absolute/private/root
gbc sync render --dir /absolute/private/root
gbc sync attachments --dir /absolute/private/root \
  --account-id <stable-id> --team-id none --ack-unverified-scope
```

身份是操作者显式声明，不是服务端验证；请用稳定 ID，不要用邮箱 / token 哈希。格式、预算与恢复步骤见 [docs/control-plane/sync-format.md](https://github.com/younglark/grokbot-control/blob/main/docs/control-plane/sync-format.md)。

## Docs

| 文档 | 内容 |
|---|---|
| [docs/control-plane/requirements.md](https://github.com/younglark/grokbot-control/blob/main/docs/control-plane/requirements.md) | 需求、非目标、验收场景 |
| [docs/control-plane/architecture.md](https://github.com/younglark/grokbot-control/blob/main/docs/control-plane/architecture.md) | 模块、错误、写安全 |
| [docs/control-plane/implementation-status.md](https://github.com/younglark/grokbot-control/blob/main/docs/control-plane/implementation-status.md) | 实现状态与验收边界 |
| [docs/control-plane/sync-format.md](https://github.com/younglark/grokbot-control/blob/main/docs/control-plane/sync-format.md) | 文件同步格式与限制 |
| [docs/control-plane/auth-lock.md](https://github.com/younglark/grokbot-control/blob/main/docs/control-plane/auth-lock.md) | 原生跨进程 refresh 锁 |
| [docs/protocol/protocol-map.md](https://github.com/younglark/grokbot-control/blob/main/docs/protocol/protocol-map.md) | 覆盖矩阵 / RPC / Auth 契约 |
| [docs/protocol/](https://github.com/younglark/grokbot-control/blob/main/docs/protocol/README.md) | 协议基线、静态还原、App 更新 runbook |
| [docs/protocol/references.md](https://github.com/younglark/grokbot-control/blob/main/docs/protocol/references.md) | 一手来源 |
| [docs/HANDOFF.md](https://github.com/younglark/grokbot-control/blob/main/docs/HANDOFF.md) | 项目现状与交接 |
| [vendor/proto-gen/NOTICE.md](vendor/proto-gen/NOTICE.md) | 生成客户端来源与许可说明 |

## Development

```bash
npm install                    # 开发期；CI 用 npm ci
npm run dev -- --mock --json computer state
npm run build
npm test
npm run typecheck
npm run test:protocol-tools   # 可选：协议工具 Python 单测
```

在仓库根目录等价的快捷命令：

```bash
npm run dev:gbc -- --mock --json computer state
npm run dev:mcp
```

本地入口：

```bash
npm run gbc -- --mock --json bot list
npm run mcp                   # 或：GBT_MOCK=1 node packages/grokbot-control/dist/mcp/main.js
```

源码布局概览：`src/auth`、`src/connect`、`src/ops`、`src/sync`、`src/cli`、`src/mcp`；唯一冻结 `.proto` 在 `packages/protocol/baselines/schema-0.79.3/`，本公开包携带本地 `vendor/proto-gen/` 生成制品，不依赖私有 workspace。

## Publish / Release

包名 [`grokbot-control`](https://www.npmjs.com/package/grokbot-control)。**未声明 SPDX `license`**：`vendor/proto-gen` 来自逆向恢复的 schema，许可不清，见 [vendor/proto-gen/NOTICE.md](vendor/proto-gen/NOTICE.md)；请自行评估分发风险。

后续发版走 **GitHub Actions + npm Trusted Publishing（OIDC）**，无需仓库里的 `NPM_TOKEN`：

1. 工作区干净，本地 `npm run build && npm test` 通过。
2. 另获发版授权后，从根使用 `npm version patch -w grokbot-control --no-git-tag-version`（或 minor/major）更新公开子包与根 lock；审查 release commit 后再显式创建 `vX.Y.Z` tag，不能对 private 根包做版本发布。
3. `git push origin main --follow-tags`。
4. [`.github/workflows/publish.yml`](https://github.com/younglark/grokbot-control/blob/main/.github/workflows/publish.yml) 在推送 `v*` tag 时：根 `npm ci` → 指定 control workspace build/test → 在 `packages/grokbot-control` 内 `npm publish --access public`。

Trusted Publisher（npm 包 Settings）应对齐：

- Organization or user：`younglark`
- Repository：`grokbot-control`
- Workflow filename：`publish.yml`

GitHub Release **不会**触发发布；可在 tag 推送后再基于该 tag 建 Release，不会重复 publish。已发布版本不要重推同名 tag。

## License / NOTICE

- 本仓库**未**附带根目录 SPDX LICENSE 文件。
- 生成器 / 运行时（Buf、Connect）为 **Apache-2.0**。
- 协议 schema 与 `vendor/proto-gen`：**无单独官方许可声明**，由维护者从 App 静态提取恢复生成；事实来自逆向 schema，见 [vendor/proto-gen/NOTICE.md](vendor/proto-gen/NOTICE.md) 与 [docs/protocol/baseline-manifest.md](https://github.com/younglark/grokbot-control/blob/main/docs/protocol/baseline-manifest.md)。
- 跨进程锁依赖 `fs-native-extensions@1.5.3`（Apache-2.0）；Node 20+，Linux / macOS / Windows 预编译。详见 [docs/control-plane/auth-lock.md](https://github.com/younglark/grokbot-control/blob/main/docs/control-plane/auth-lock.md)。

## 本地执行端子包：local-exec-daemon

同仓库的私有子包 [`packages/local-exec-daemon`](https://github.com/younglark/grokbot-control/tree/main/packages/local-exec-daemon)，目标是与 App 0.79.3 原版 local-exec-daemon 行为一致。它不随本包发布，与 SDK、`gbc`、`gbc-mcp` 分开构建；目前只做过离线合成环境的验证，不是完整 drop-in。说明见 [docs/local-exec/](https://github.com/younglark/grokbot-control/blob/main/docs/local-exec/README.md)。

