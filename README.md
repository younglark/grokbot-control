# grokbot-control

**人通过 Grok Bot App 驱动 → agent CLI 经 MCP/CLI 驱动同一 Bot。**  
可编程控制面（原生 Connect RPC），非自建任务系统。

CLI 暂称 **`gbc`**；MCP stdio 入口 **`gbc-mcp`**。

> Live auth / production RPC **未在本轮验证**。默认 `--mock` 仅用于显式仿真（结果带 `simulated: true`），不是在线成功。

## 快速开始

```bash
npm ci
npm run build
npm test

# 显式 mock 仿真（跨进程状态：GBT_MOCK_STATE 或 ~/.gbc/mock-state.json）
node dist/cli/main.js --mock --json --allow-writes bot create --name demo --description "test"
node dist/cli/main.js --mock --json bot list
node dist/cli/main.js --mock --json --allow-writes message send \
  --agent-id <id> --session-id <sid> --text "hello"
node dist/cli/main.js --mock --json bot status --agent-id <id>
node dist/cli/main.js --mock --json --allow-writes sidebar create --name Work
node dist/cli/main.js --mock --json --allow-writes sidebar move --agent-id <id> --section-id <sid>
node dist/cli/main.js --mock --json --allow-writes bot delete --agent-id <id> --confirm <id>

# MCP（stdio；stdout 仅协议帧）
GBT_MOCK=1 node dist/mcp/main.js
```

Live Connect（真实登录需用户本人在浏览器授权；本仓库测试只用本地 fake 后端）：

```bash
# 不要设置 GBT_MOCK / GBT_ALLOW_WRITES；默认 backend https://api2.cursor.sh，网站 https://cursor.com
node dist/cli/main.js --json auth login-begin        # stdout: authorization_url（不含 verifier）
#   → 用户在浏览器打开该 URL 并登录
node dist/cli/main.js --json auth complete --timeout 300   # 轮询 GET /auth/poll；成功后凭据写入 ~/.gbc（0600）
# 或单命令：auth login --timeout 300（URL 走 stderr 的 open_browser 事件，stdout 只放结果）
node dist/cli/main.js --json auth whoami             # 本地状态，不联网、不打印 token
node dist/cli/main.js --json bot list --limit 20     # 只读
node dist/cli/main.js --json sidebar list
node dist/cli/main.js --json bot status --agent-id <agent_id>
node dist/cli/main.js --json auth logout             # 只删本工具自己的本地凭据
```

鉴权限制（详见 docs/protocol-map.md「Auth」）：
- 协议来自 Grok Bot Linux App **静态逆向**，非官方公开 API。`vendor/proto-gen` 现为 **0.79.3**（本仓库从App恢复生成，离线校验）。2026-11-07 的人工 live 验证（浏览器登录 + 只读 `bot list` / `sidebar list` / `bot status`）使用的是**旧 0.78.4 vendor**；0.79.3 vendor 尚未 live 调用。刷新与所有写操作**未** live 验证。
- 仅支持 Cursor token；xAI identity 登录结果返回 `unsupported`。
- 刷新需显式配置公开 OAuth client_id：`GBT_OAUTH_CLIENT_ID`（本工具不内置）。未配置时 token 过期后需重新登录。
- 凭据独立于 App（不读取、不复用 App 的 sand-secrets.json）。logout 只删本地文件，不吊销服务端会话。
- MCP：`GBT_MCP_READONLY=1 node dist/mcp/main.js` 提供 `auth_whoami / auth_login_begin / auth_login_complete(≤120s) / auth_login_cancel / auth_logout` + 只读工具。

## 文档

| 文件 | 内容 |
|---|---|
| [docs/requirements.md](docs/requirements.md) | 需求 |
| [docs/protocol-map.md](docs/protocol-map.md) | 覆盖矩阵 / RPC |
| [docs/protocol/](docs/protocol/README.md) | 协议基线、静态还原方法、App 更新 runbook、兼容矩阵、`tools/protocol` 脚本 |
| [docs/architecture.md](docs/architecture.md) | 模块 / 错误 / 写安全 |
| [docs/implementation-plan.md](docs/implementation-plan.md) | 分期 |
| [docs/acceptance.md](docs/acceptance.md) | 验收 |
| [docs/review.md](docs/review.md) | 审查 |
| [docs/references.md](docs/references.md) | 一手来源 |
| [docs/implementation-status.md](docs/implementation-status.md) | 实现状态 |
| [/workspace/grokbot-control-implementation.md](../grokbot-control-implementation.md) | 本轮实现报告 |

## 退出码

`0` success · `2` usage · `4` auth · `5` not_found · `6` conflict · `7` denied · `8` retryable · `9` failure · `10` unknown · `1` other

## 协议 vendor

正式协议源见 `proto/`；生成客户端见 `vendor/proto-gen/NOTICE.md`（App `0.79.3` commit `4739412`，本仓库从App恢复生成；生成器 Buf Connect Apache-2.0；schema 本身无单独官方许可声明）。
