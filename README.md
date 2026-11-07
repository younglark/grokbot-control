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
node dist/cli/main.js --json auth refresh            # 临期才联网；足够新则 refreshed:false
node dist/cli/main.js --json auth refresh --force    # 强制刷新（验证/401恢复）
node dist/cli/main.js --json bot list --limit 20     # 只读
node dist/cli/main.js --json sidebar list
node dist/cli/main.js --json bot status --agent-id <agent_id>
node dist/cli/main.js --json auth logout             # 只删本工具自己的本地凭据
```

鉴权限制（详见 docs/protocol-map.md「Auth」）：
- 协议来自 Grok Bot Linux App **静态逆向**，非官方公开 API。`vendor/proto-gen` 现为 **0.79.3**（本仓库从App恢复生成，离线校验）。较早人工登录验证使用旧0.78.4 vendor；0.79.3 的选定正常RPC已进行隔离临时bot验收，范围/skip见 implementation-status。不能由此推定所有RPC或OAuth刷新已验证。
- 仅支持 Cursor token；xAI identity 登录结果返回 `unsupported`。
- 刷新需显式配置公开 OAuth client_id：`GBT_OAUTH_CLIENT_ID`（本工具不内置，也不从 JWT 猜测），或登录时已持久化的绑定；旧凭据可用 `GBT_AUTH_CONFIRM_MIGRATE=1` 确认迁移。临期（<5min）/缺非法 exp / `--force` 才刷新；进程内 singleflight + 跨进程锁；`shouldLogout` 不回退已撤销 token。
- 凭据独立于 App（不读取、不复用 App 的 sand-secrets.json）。logout 只删本地文件，不吊销服务端会话。
- MCP：`GBT_MCP_READONLY=1 node dist/mcp/main.js` 仅提供 `auth_whoami` + 只读业务工具（不含 login/logout/cancel/refresh 凭据写工具）。非 READONLY 另有 `auth_refresh`（仅非 secret 元数据）。

## 文件优先同步（无 SQLite）

CLI：`gbc sync pull --agent-id BOT [--session-id SESSION] --dir /absolute/private/root
--account-id STABLE_ID --team-id none --ack-unverified-scope`；`gbc sync status|render|attachments --dir /absolute/private/root`。
pull/render/attachments 明确授权本地写，不需要远端 `--allow-writes`；`--dry-run` 纯本地计划、无 RPC/文件。
身份是操作者显式声明而非服务端验证，必须核对稳定 ID，不能用邮箱/token 哈希。
**render 已可直接 rg 已确认 JSON UI entry 的正文**：message、send-message(text/attachment)、notice、
tool-call 名称/状态/summary、附件文件引用；其余类型/未知 body 仍 opaque，不猜解密。
正文补读显式开启 `sync pull ... --hydrate missing`（默认 `off`，不默默增加网络请求）。inline 优先；
omitted 精确重读同版本；blob 仅通过 store presign 读取正文，不是用户附件。原始 wire/protojson 不覆盖，
补读 bytes/本地 SHA-256/来源/版本上下文另存，JSONL 与离线 render 均可 grep。请求失败/无法解码返回 `partial`（exit 9），已归档行保留。
默认额外 RPC 32、正文传输/响应总 8MiB、单正文 4MiB，与 pull 总字节/截止时间共享；参数见格式文档。
静态解码证据和 synthetic genuine-schema fixture 见 [transcript-body-0.79.3.md](docs/protocol/transcript-body-0.79.3.md)。
例如 `rg '关键词' /absolute/private/root/derived -g '*.md'`；旧 opaque 归档可离线重新 render。
head刷新与持久化backfill交替，不删缺失行，不承诺完整性；附件单独按需下载；无Watch/`--all`。
MCP 设 `GBT_SYNC_ROOT` 才提供 `sync_status`，另需 `GBT_SYNC_ALLOW_LOCAL_WRITES=1` 才有
`sync_pull/sync_render/sync_attachments`（READONLY 排除写工具；scope 在启动配置；attachments 可选远端 file_path 过滤）。
命令示例、scope 限制、格式与恢复步骤见 [docs/sync-format.md](docs/sync-format.md)。

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
| [docs/sync-format.md](docs/sync-format.md) | 文件同步格式、身份限制、预算、崩溃恢复 |
| [docs/implementation-status.md](docs/implementation-status.md) | 实现状态 |
| [/workspace/grokbot-control-implementation.md](../grokbot-control-implementation.md) | 本轮实现报告 |

## 退出码

`0` success · `2` usage · `4` auth · `5` not_found · `6` conflict · `7` denied · `8` retryable · `9` failure · `10` unknown · `1` other

## 协议 vendor

正式协议源见 `proto/`；生成客户端见 `vendor/proto-gen/NOTICE.md`（App `0.79.3` commit `4739412`，本仓库从App恢复生成；生成器 Buf Connect Apache-2.0；schema 本身无单独官方许可声明）。

### 同步修订
支持默认session、generation内持久化backfill与跨调用session轮转；归档是retained observations，不是删除同步/完整镜像。
附件仅按需App store aliases，用户上传和send-message attachment均支持；每次Resolve+条件GET，流式预算与scope绑定。
attachments需与pull一致的`--account-id --team-id --ack-unverified-scope`。
`--page-size 1 --max-pages 1`可做小量分页验收。详细边界见[格式文档](docs/sync-format.md)。

### Native auth lock installation
跨进程 refresh 使用 `fs-native-extensions@1.5.3` 原生 OS advisory lock（非外部 flock 命令、非 mtime lease）。
Node20+，Linux/macOS/Windows x64/arm64 npm包预编译；缺binding fail closed。升级前停止全部旧MCP进程，旧Linux flock与新OFD锁不互通。
Linux x64已实测；macOS/Windows仅源码检查+CI矩阵，未在本机执行。Windows需另核查用户目录ACL；只支持本地文件系统。
详见 [native lock构建/平台/证据](docs/auth-lock.md)。
