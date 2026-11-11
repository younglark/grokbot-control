# grokbot-control

**人通过 Grok Bot App 驱动 → agent CLI 经 MCP / CLI 驱动同一 Bot。**

可编程控制面（原生 Connect RPC），不是另建任务系统。CLI 入口 **`gbc`**，MCP stdio 入口 **`gbc-mcp`**。版本 **0.3.0**，通过 GitHub tag `npm-v0.3.0` 安装。npmjs 上的 0.1.3 已停止更新。

> 非官方产品。协议来自 Grok Bot 桌面 App 的静态逆向，**不是**公开 API。自动化测试以 mock 为主；部分选定 RPC 曾做过隔离 live 验收，范围见 [docs/control-plane/implementation-status.md](https://github.com/younglark/grokbot-control/blob/main/docs/control-plane/implementation-status.md)，不能据此推定全部 RPC / OAuth 刷新已验证。

## Why

App 里能做的 Bot 生命周期、发消息、侧边栏、进度与中断，希望由上层 agent / 脚本以同一后端能力完成，而不是再造一套 task 状态机。

## Features

- **Bot**：create / list / get（list 筛选）/ update / delete
- **电脑**：state、reset（`preserve_data:false`）、`--hard`、`--wait` 阶段进度
- **消息与会话**：send、send status、history、sessions
- **侧边栏**：SidebarSections CRUD、移动成员（删除分组 ≠ 删除 Bot）
- **进度**：status、原生 todos / tasks / subagents、interrupt
- **鉴权**：独立 Cursor 浏览器登录（默认 `cli`）；可选 `bot` 登录模式使用与官方 App 相同的 URL 形态；凭据存 `~/.gbc`（0600）；不读取 App 的 `sand-secrets.json`
- **文件同步**：`sync pull|status|render|attachments`（无 SQLite；细节见 [docs/control-plane/sync-format.md](https://github.com/younglark/grokbot-control/blob/main/docs/control-plane/sync-format.md)）
- **双入口**：同一 shared SDK → CLI（`gbc`）与 MCP（`gbc-mcp`）
- **写安全**：远端写需 `--allow-writes`；危险操作需 `--confirm=<id>`；`--dry-run` 纯本地计划。MCP 默认只注册只读工具与 auth，写工具需 `GBT_ALLOW_WRITES=1` 或 `--allow-writes`
- **Agent 输出**：CLI 成功 stdout 在终端和管道下都是同一套 ResultEnvelope；`--plain` 只输出 data。未知 flag 以退出码 2 拒绝。列表默认 `--limit=50`，截断时带 `truncated` / `next` / `hint`

## Install

需要 **Node.js ≥ 20**，以及能克隆本私有仓库的 GitHub 认证。仓库是私有的：先 `gh auth login`（HTTPS，并允许 gh 作为 git credential helper），或配置 [GitHub SSH key](https://docs.github.com/en/authentication/connecting-to-github-with-ssh)。包名是 `grokbot-control`，可执行文件是 `gbc` 和 `gbc-mcp`，两者不一致，**必须**加 `--package`，否则 npx 无法选定要跑的 bin。

### npx（推荐，钉到 tag）

```bash
npx -y --package=github:younglark/grokbot-control#npm-v0.3.0 gbc --help
npx -y --package=github:younglark/grokbot-control#npm-v0.3.0 gbc --mock --json bot list
npx -y --package=github:younglark/grokbot-control#npm-v0.3.0 gbc-mcp
```

请钉 `npm-v0.3.0` 这类 tag，不要用 `#main`（仓库根是 workspace，没有 `gbc` bin）。等价形式：`git+ssh://git@github.com:younglark/grokbot-control.git#npm-v0.3.0`。

### 全局安装（从同一个 git tag）

```bash
npm install --global github:younglark/grokbot-control#npm-v0.3.0
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
npx -y --package=github:younglark/grokbot-control#npm-v0.3.0 gbc --mock --json --allow-writes \
  bot create --name demo --description "test"
npx -y --package=github:younglark/grokbot-control#npm-v0.3.0 gbc --mock --json bot list
npx -y --package=github:younglark/grokbot-control#npm-v0.3.0 gbc --mock --json --allow-writes \
  message send --agent-id <id> --session-id <sid> --text "hello"
npx -y --package=github:younglark/grokbot-control#npm-v0.3.0 gbc --mock --json bot status --agent-id <id>
```

### Live（真实后端）

默认 backend `https://api2.cursor.sh`，网站 `https://cursor.com`。不要设置 `GBT_MOCK`。

```bash
gbc --json auth login --timeout 300
# URL 走 stderr 的 open_browser 事件；也可分步：
#   gbc --json auth login-begin
#   gbc --json auth complete --timeout 300
# 可选 Bot 风格登录（App URL：redirectTarget=sand + supportsSelectedTeamLogin=true；默认仍是 cli）：
#   gbc --json auth login --login-mode bot --timeout 300

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

**默认只读。** `gbc-mcp` 只注册只读业务工具和 `auth_*`（以便登录）。写工具（`create_bot`、`delete_bot`、`send_message`、`reset_computer`、`interrupt_run`、sidebar 写等）不会出现在 `tools/list` 里，除非宿主显式开启写权限。

从 0.1.x 迁移：以前只要在工具参数里传 `allow_writes=true` 就能写。0.2.0 起必须在 MCP 配置里设置 `GBT_ALLOW_WRITES=1` 或给进程加 `--allow-writes`，写工具才会出现。单靠工具参数不能再自我授权。`GBT_MCP_READONLY=1` 仍然更严（连 login/logout/refresh 也隐藏），并且优先于 `GBT_ALLOW_WRITES`。

默认（只读 + 可登录）：

```json
{
  "mcpServers": {
    "grokbot-control": {
      "command": "npx",
      "args": ["-y", "--package=github:younglark/grokbot-control#npm-v0.3.0", "gbc-mcp"],
      "env": {
        "GBT_OAUTH_CLIENT_ID": "<your-public-oauth-client-id>"
      }
    }
  }
}
```

如需默认使用 Bot 风格登录 URL，再设置 `"GBT_LOGIN_MODE": "bot"`；也可在调用 `auth_login_begin` 时传入 `login_mode: "bot"`，不必改启动配置。两种方式都不会读取官方 App 凭据。

需要写工具时：

```json
{
  "mcpServers": {
    "grokbot-control": {
      "command": "npx",
      "args": ["-y", "--package=github:younglark/grokbot-control#npm-v0.3.0", "gbc-mcp", "--allow-writes"],
      "env": {
        "GBT_OAUTH_CLIENT_ID": "<your-public-oauth-client-id>",
        "GBT_ALLOW_WRITES": "1"
      }
    }
  }
}
```

CLI 输出：成功结果在 TTY 和管道下都是同一套 `schema_version` 封套。`--json` 为紧凑 JSON（推荐给 agent）；TTY 未加 `--json` 时美化同一封套；只要 data 时用 `--plain`。未知 flag 退出码 2。

常用环境变量：

| 变量 | 说明 |
|---|---|
| `GBT_ALLOW_WRITES=1` 或启动参数 `--allow-writes` | 注册并允许远端写工具（默认不注册） |
| `GBT_MCP_READONLY=1` | 仅 `auth_whoami` + 只读业务工具（不含 login/logout/cancel/refresh 及写工具）；优先于 `GBT_ALLOW_WRITES` |
| `GBT_OAUTH_CLIENT_ID` | 公开 OAuth client id（刷新用；不内置） |
| `GBT_LOGIN_MODE` | 登录 URL 预设：`cli`（默认）或 `bot`（App 形态）。也可在 CLI 用 `--login-mode`，MCP 用 `auth_login_begin.login_mode` |
| `GBT_LOGIN_REDIRECT_TARGET` | 只覆盖 `redirectTarget`（兼容旧配置）；未设置时跟随 `GBT_LOGIN_MODE` 的默认值（cli→cli，bot→sand） |
| `GBT_CREDENTIALS_DIR` | 凭据目录，默认 `~/.gbc` |
| `GBT_SYNC_ROOT` | 设置后才提供 `sync_status` |
| `GBT_SYNC_ALLOW_LOCAL_WRITES=1` | 在已开启 `GBT_ALLOW_WRITES` 时，另需才提供 `sync_pull` / `sync_render` / `sync_attachments` |
| `GBT_SYNC_ACCOUNT_ID` / `GBT_SYNC_TEAM_ID` / `GBT_SYNC_ACK_UNVERIFIED_SCOPE=1` | sync pull 作用域（操作者声明，非服务端验证） |

更严的只读试跑（连 auth 变更工具也去掉）：

```bash
GBT_MCP_READONLY=1 npx -y --package=github:younglark/grokbot-control#npm-v0.3.0 gbc-mcp
```

主要工具：`list_bots`、`get_bot`、`create_bot`、`update_bot`、`delete_bot`、`get_computer_state`、`reset_computer`、`send_message`、`get_send_status`、`list_transcript`、`list_sessions`、`get_bot_status`、`list_agent_todos`、`list_agent_tasks`、`list_agent_subagents`、`interrupt_run`、sidebar 系列、`auth_*`、可选 `sync_*`。完整契约见 [docs/protocol/protocol-map.md](https://github.com/younglark/grokbot-control/blob/main/docs/protocol/protocol-map.md)。

## Auth

独立 Cursor 浏览器登录（静态逆向协议，非官方公开 API）。仅支持 Cursor token；xAI identity 返回 `unsupported`。

默认登录模式是 `cli`（`redirectTarget=cli`，不含 `supportsSelectedTeamLogin`；2026-11-07 曾 live 验证）。可选 `bot` 模式只改变登录 URL，使其与官方 App 一致（`redirectTarget=sand` + `supportsSelectedTeamLogin=true`）。每次都会新生成 uuid / challenge / verifier。凭据仍只写在 `~/.gbc`，不读取官方 App 的 `sand-secrets.json` 或钥匙串，不猜测 team id，也不发送 `x-cursor-team-id` 或其它官方头。bot 模式的登录轮询收束已于 2026-11-11 live 验证（Cursor token，backend api2）。选中团队如何返回/绑定、以及该模式之后的刷新仍**尚未 live 验证**。

| 命令 | 作用 |
|---|---|
| `gbc --json auth login-begin [--login-mode cli\|bot]` | 输出 `authorization_url`（不含 verifier） |
| `gbc --json auth complete --timeout 300` | 轮询 `/auth/poll`；成功后写入 `~/.gbc`（0600） |
| `gbc --json auth login [--login-mode cli\|bot] --timeout 300` | begin + complete；URL 经 stderr |
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
gbc [--json] [--mock] [--allow-writes] [--dry-run] [--base-url URL] [--auth-kind cursor|xai] [--login-mode cli|bot] <noun> <verb> [flags]
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

包名仍是 `grokbot-control`。从 0.2.0 起**不再发布到 npmjs**；[npmjs 上的 0.1.3](https://www.npmjs.com/package/grokbot-control) 已停止更新。**未声明 SPDX `license`**：`vendor/proto-gen` 来自逆向恢复的 schema，许可不清，见 [vendor/proto-gen/NOTICE.md](vendor/proto-gen/NOTICE.md)；请自行评估分发风险。

正式发版在仓库根进行：先把源码变更推到 `main`，再推送 `v<version>`，由 GitHub Actions 生成父提交为空的安装树 tag `npm-v<version>`（`npm pack` 产物，已去掉生命周期脚本，不含 main 历史）。

1. 在干净的 `main` 上准备好版本号。需要 bump 时：`npm version patch -w grokbot-control --no-git-tag-version`（或 minor/major），审查后提交并推送 `main`。不要再走 npmjs Trusted Publishing。
2. `export UC_SKIP_OFFICIAL=1` 后可先跑 `npm run verify:package` 和 `npm run release:github` 做本地预览（默认会跑 `generate:check`、`build`、`npm test`；`--skip-tests` 可跳过，但默认要跑）。预览只会生成孤立 commit，默认不打官方 `npm-v*` tag。
3. 确认 Actions 能跑之后，在对应的 `main` 提交上执行 `git tag -a v0.3.0 <main-commit>`，再 `git push origin refs/tags/v0.3.0`。工作流会打并推送 `npm-v0.3.0`。不要从本机推送 `npm-v*`。同名 tag 已存在时任务失败，不会 force-push。
4. **推 `v*` 前确认 Actions 能跑完。** `v0.2.1` 的发版已成功生成 `npm-v0.2.1`。已推送的 `v0.2.0` / `v0.2.1` 不要删除或改写；`v0.2.0` 的发版任务因测试挂起被取消，没有生成 `npm-v0.2.0`。

仓库里已删除 `.github/workflows/publish.yml`，推送任何 tag 都不会再发布到 registry.npmjs.org。建议同时在 npmjs 包设置里撤销 Trusted Publisher 绑定。

## License / NOTICE

- 本仓库**未**附带根目录 SPDX LICENSE 文件。
- 生成器 / 运行时（Buf、Connect）为 **Apache-2.0**。
- 协议 schema 与 `vendor/proto-gen`：**无单独官方许可声明**，由维护者从 App 静态提取恢复生成；事实来自逆向 schema，见 [vendor/proto-gen/NOTICE.md](vendor/proto-gen/NOTICE.md) 与 [docs/protocol/baseline-manifest.md](https://github.com/younglark/grokbot-control/blob/main/docs/protocol/baseline-manifest.md)。
- 跨进程锁依赖 `fs-native-extensions@1.5.3`（Apache-2.0）；Node 20+，Linux / macOS / Windows 预编译。详见 [docs/control-plane/auth-lock.md](https://github.com/younglark/grokbot-control/blob/main/docs/control-plane/auth-lock.md)。

## 本地执行端子包：local-exec-daemon

同仓库的私有子包 [`packages/local-exec-daemon`](https://github.com/younglark/grokbot-control/tree/main/packages/local-exec-daemon)，目标是与 App 0.79.3 原版 local-exec-daemon 行为一致。它不随本包发布，与 SDK、`gbc`、`gbc-mcp` 分开构建；目前只做过离线合成环境的验证，不是完整 drop-in。说明见 [docs/local-exec/](https://github.com/younglark/grokbot-control/blob/main/docs/local-exec/README.md)。

