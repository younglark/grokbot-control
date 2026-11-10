# 控制面架构

## 1. 定位

人原先在 **Grok Bot App** 操作；本项目提供 **MCP + CLI** 可编程控制面，经 **Connect 原生 RPC** 驱动同一后端。  
上层 agent CLI 负责需求沟通与编排；本层**不**强制自建 task 账本。

```
上层 agent CLI / 人
   ├─ MCP adapter (stdio…)     ─┐
   └─ CLI adapter (示意 gbc)   ─┴─► shared SDK
                                      ├─ auth/credentials（独立 store）
                                      ├─ connect client + interceptors
                                      ├─ ops: bot | message | session | sidebar | progress
                                      └─ outcome/error 归一
                                           │
                                           ▼
                                      GrokBotService / DashboardService
```

## 2. 模块与目录（`packages/grokbot-control/src/`）

```
src/
  auth/           # bootstrap, store, refresh single-flight, logout(本地)
  connect/        # transport, headers, deadline, error map
  ops/          # bot / message / session / sidebar / progress / computer / auth（Room 未实现）
  sync/         # 文件归档、附件、正文补读
  dto/          # 稳定 JSON schema_version
  cli/          # 薄适配
  mcp/          # 薄适配 + toolsets
  testing/      # mock 后端
```

**禁止默认提供：** 任意 `raw_rpc`、Admin/Internal 代理、Vault 明文工具。

## 3. 原生 ID 与命名

| 概念 | 协议字段 | SDK/DTO 建议 |
|---|---|---|
| Bot | `GrokBotAgent.agent_id` 与 `id` 均存在 | 对外主字段 `agent_id`；写入时与 App 一样以客户端 nonce 预分配（create） |
| Session | `viewer_session_id` / 请求 `session_id` | `session_id`；默认：若未传则用 list 中该 bot 的 `viewer_session_id`（**待真机确认始终有效**） |
| Message | 客户端生成 `message_id` | UUID；**丢响应后不自动重发同 id 除非有服务端幂等证据**（未证实前不承诺） |
| Transcript cursor | `generation` / seq | DTO 保留；Watch 短生命周期 |
| Sidebar section | `id`,`name`,`agent_ids` | 删除 section ≠ 删除 bot |

**无独立 GetBot RPC：** `bot.get` = `ListGrokBotAgents` 后客户端按 `agent_id` 筛选；找不到→`not_found`。

## 4. 统一结果契约（CLI `--json` 与 MCP structuredContent）

```json
{
  "schema_version": "1.0.0",
  "ok": true,
  "outcome": "known_success | known_failure | unknown",
  "code": "STRING_CODE",
  "retryable": false,
  "request_id": "uuid",
  "data": {},
  "error": { "message": "", "hint": "" }
}
```

- MCP：业务失败优先 `isError: true` + 同上 JSON 文本/structuredContent（对齐 MCP tools 规范）。  
- CLI：stdout 仅结果 JSON/文本；错误 JSON→stderr；退出码表见下。  
- **MCP stdio 进程禁止打印 CLI 风格日志到 stdout。**

### CLI 退出码（设计决定；写入 --help 后不改含义）

| 码 | 含义 |
|---:|---|
| 0 | known_success |
| 2 | usage |
| 4 | auth |
| 5 | not_found |
| 6 | conflict（含 sidebar base 冲突） |
| 7 | denied / dry-run 外的写拒绝 |
| 8 | retryable（瞬时） |
| 9 | known_failure |
| 10 | unknown outcome（丢响应、证据不足） |
| 1 | 其它错误 |

## 5. 写安全

- 删除/破坏性：`--confirm=<agent_id>`（或资源名）+ 可选 `--dry-run`（**纯**无 RPC）  
- create/send/delete：**超时/取消后不自动重试写**；引导 `list`/`get_send_status`/transcript 对账；无法判定→`unknown`  
- idempotency：**仅当真机证明**服务端对 `message_id`/`agent_id` 去重后，才在文档承诺；此前标「客户端尽最大努力」  
- sidebar：read → 本地改最小 sections 集合 → write(sections, base=读到的快照) → read verify；进程内锁；**不声称跨 App 事务**

## 6. Auth

- 独立 bootstrap（browser URL + 内存 verifier + poll）；secure store；refresh 跨进程单飞锁  
- account scope 与 `GBT_BASE_URL`（或配置 backend）绑定；自定义 backend 需显式信任确认，防 token 打到错误域（RFC9700 / 鉴权报告）  
- Cursor vs xAI kind 分离；logout 只清本工具凭据  
- 无 auto-approve；不读桌面 sand-secrets  

## 7. 进展模型

| 层 | 含义 | 不可当作 |
|---|---|---|
| delivery / send_status | 发送路径接受 | 任务业务成功 |
| live running / awaiting | App 状态条 | 最终用户可见完成 |
| transcript 助手可见消息 | 用户可见进展 | 自动「验收通过」 |
| Interrupt | 中断 run | MCP cancelled 通知 |

Watch：按需、有界、可取消订阅；断连/CLI 退出 **默认不** Interrupt。

## 8. 工具面治理（借鉴 GitHub MCP）

建议 toolsets：`auth` / `bot` / `message` / `sidebar` / `progress` / `room(opt)`；默认启用前四+progress；`--read-only` 跳过写工具。

## 9. CLI 设计：规范 / 本项目决定 / 待验证

| 项 | 归类 | 说明 |
|---|---|---|
| stdout=数据、stderr=诊断；无 TTY 不阻塞 | **规范要求**（agent-cli-design / clig 共识） | MCP stdio 进程另遵守 MCP transports，禁止夹带 CLI JSON |
| 退出码分类表写入 --help 后不改 | **规范要求** | 见 §4 |
| `--json` 字段稳定 + schema_version | **规范要求** | 人类文本可迭代 |
| 列表默认 limit + truncated hint | **规范要求** | |
| dry-run 纯 + `--confirm=<id>` | **规范要求**（破坏性确认共识） | 避免万能 `--yes` |
| 默认输出文本还是 JSON | **有争议**→**本项目决定（0.2.0）**：成功 stdout 在 TTY 和管道下都是同一套 ResultEnvelope；`--json` 为紧凑 JSON（推荐给 agent）；TTY 未加 `--json` 时美化同一封套；`--plain` 只输出 data | 不再按 TTY 切换对象形状 |
| 幂等键对 create/send | **待验证** | 未证实服务端去重前不承诺 |
| `--agent` / `--no-input` 命名 | **有争议** | 先用 isatty + 无提示；命名后定 |
| 默认只读全局开关 | **有争议**→**本项目决定（0.2.0）**：MCP 默认不注册写工具，需 `GBT_ALLOW_WRITES=1` 或 `--allow-writes`；`GBT_MCP_READONLY=1` 更严并优先。CLI 写操作仍需 `--allow-writes` + confirm | |
