# 一手来源与访问记录

访问日期：**2026-11-07（Asia/Shanghai）**。下列 URL 本轮实际打开；摘要仅据页面正文，非搜索摘要。

## MCP（钉 2025-11-25 兼容基线；latest 另见 2026-07-28）

| URL | 摘要 |
|---|---|
| https://modelcontextprotocol.io/specification/2025-11-25/server/tools | Tool schema；`annotations` **不可当信任权限**；结果可含 `isError`、`structuredContent` |
| https://modelcontextprotocol.io/specification/2025-11-25/basic/transports | stdio 与 Streamable HTTP；断连 **≠** 取消；取消用 `notifications/cancelled` |
| https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization | Authorization **可选**；**stdio SHOULD NOT** 跟 HTTP OAuth 规范 |
| https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation | 取消通知语义；initialize 不可取消；接收方可不响应已取消请求 |
| https://modelcontextprotocol.io/specification/latest | 本轮重定向至 **2026-07-28**（此前已核） |

## Connect / Protobuf

| URL | 摘要 |
|---|---|
| https://connectrpc.com/docs/protocol/ | `connect-timeout-ms`；幂等注解 `IdempotencyLevel`；取消与超时 |
| https://connectrpc.com/docs/go/errors/ | `ConnectError` 码；`deadline_exceeded`/`canceled`/`unknown`；RetryInfo details |
| https://protobuf.dev/programming-guides/field_presence/ | **implicit vs explicit presence**；proto3 `optional` 才有显式 presence；无 presence 时难做可靠 patch |
| https://protobuf.dev/programming-guides/proto3/#json | JSON Mapping；**int64 在 JSON 中为 string**（规范表） |
| https://buf.build/docs/reference/field-presence/ | **404**（本轮）；改用 protobuf.dev |

## OAuth

| URL | 摘要 |
|---|---|
| https://datatracker.ietf.org/doc/html/rfc8252 | OAuth 2.0 for Native Apps（public client / 系统浏览器等） |
| https://datatracker.ietf.org/doc/html/rfc7636 | PKCE（S256） |
| https://datatracker.ietf.org/doc/html/rfc9700 | OAuth 2.0 Security BCP |

**本项目注意：** App 鉴权是 loginDeepControl + `/auth/poll`（见鉴权报告）。这是产品自定义轮询，**不应自称 RFC 8628 Device Authorization Grant**。

## CLI / 双入口开源对照（只读 remote）

| 项目 | URL | stars（gh api，本轮） | 借鉴 / 不适用 |
|---|---|---:|---|
| GitHub CLI | https://cli.github.com/manual/ | 46896（cli/cli） | `--json` 字段投影；noun-verb；**不是** Connect Bot API |
| GitHub MCP Server | https://github.com/github/github-mcp-server | 34284 | **toolsets / `--read-only` / 最小 scope**；双通道（remote HTTP + local）；**原生 GitHub API，非 UI 自动化** |
| Playwright MCP | https://github.com/microsoft/playwright-mcp | 39261 | MCP vs **CLI+SKILLS** 权衡（token）；**浏览器 UI 自动化 ≠ Connect 原生 RPC** |
| Chrome DevTools MCP | https://github.com/ChromeDevTools/chrome-devtools-mcp | 54877 | MCP+CLI 双入口；明确风险声明；**DevTools/浏览器控制，非 Bot Connect** |
| clig.dev | https://clig.dev/ | — | 人类/脚本友好 CLI 指南；**非硬规范** |

## 本机协议 / 鉴权证据

| 路径 | 摘要 |
|---|---|
| `/workspace/grokbot-proto` @ `49fd8ce` | 0.78.4 Schema；本轮 RPC/字段复核 |
| `/workspace/grokbot-linux-auth-analysis.md` | 0.79.2 静态鉴权结论 |
| `/workspace/grokbot-linux-0.79.2/evidence/main-app.pretty.cjs` | App：`read/writeSidebarSections` + `sidebarSectionsBase`；`SidebarSectionsSaveConflictError`；Temporal create；delete NotFound→ok |

## 宿主 timeout（此前已核，仍有效）

OpenCode / Codex / Grok Build 官方字段为**可配置默认**，非强制上限；见历史审查。本轮未重复打开全部页面。
