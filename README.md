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

Live Connect（需另授真实登录）：

```bash
export GBT_BASE_URL=https://api2.cursor.sh
export GBT_AUTH_KIND=cursor
# 完成独立 auth 后：
node dist/cli/main.js --json --allow-writes bot list
```

## 文档

| 文件 | 内容 |
|---|---|
| [docs/requirements.md](docs/requirements.md) | 需求 |
| [docs/protocol-map.md](docs/protocol-map.md) | 覆盖矩阵 / RPC |
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

见 `vendor/proto-gen/NOTICE.md`（proto `49fd8ce` / App `0.78.4`；生成器 Buf Connect Apache-2.0；schema 本身无单独官方许可声明）。
