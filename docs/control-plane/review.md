# 方案审查（2026-11-07 Asia/Shanghai）

范围：`grokbot-control` 规划细化。无实现、无登录、无 push。

## 严重级别说明

- **P0**：会直接导致错误产品方向或不安全承诺  
- **P1**：实施前必须钉死，否则易误删/丢更新/双写  
- **P2**：质量/可运维；可分期但要写清  

## 问题 → 修订 → 依据

| # | 级别 | 旧表述/风险 | 修订 | 依据 |
|---|---|---|---|---|
| 1 | P0 | 以 task 桥为中心 / CRUD 降级 | **废止**；App 等价控制面；CRUD+直接 send 为核心 | 用户定义 + 本仓产品定义 |
| 2 | P0 | 分组猜 Room / 或「不做」 | 默认 **SidebarSections**；Room/TeamGroup 分列 | proto RuntimeSettings；App `writeSidebarSections` |
| 3 | P0 | 暗示强一致分组事务 | **无 ETag**；仅有 `sidebar_sections_base` best-effort；冲突→`SaveConflict` 类错误；本进程锁≠跨 App 安全 | App `SidebarSectionsSaveConflictError`；protobuf presence 指南 |
| 4 | P1 | Update RuntimeSettings 像「全量覆盖 settings」 | App **只写** `sidebar_sections`（+可选 base）；其它 settings 字段不随分组写带上 | main-app.pretty.cjs:131748–131754 |
| 5 | P1 | 编造 GetBot RPC / rawRPC 万能工具 | **无**独立 Get；list 客户端筛选；禁止默认 raw/admin 代理 | proto 方法表；GitHub MCP toolsets 反例（按域暴露） |
| 6 | P1 | create 字段想当然 | App 现路径走 `CreateGrokBotTemporalAgent`（同 Request）；需 `agent_id` nonce、`harness=TEMPORAL`、`description`/`name`、kickstart/introduction 组合；0.79 App 代码另传 visibility/teamId 等 **0.78.4 Request 无这些字段**→标 drift | App create()；snapshot CreateGrokBotAgentRequest |
| 7 | P1 | delete 副作用猜会清 sidebar | **未证实**；delete 仅 `DeleteGrokBotAgent{id}`；NotFound 当 ok；sidebar 残留待真机 | App g_t delete |
| 8 | P1 | 丢响应后自动重试 create/send/delete | **禁止**自动重发；对账→`outcome=unknown` | Connect timeout/cancel；CLI 幂等共识；MCP cancel≠业务 Interrupt |
| 9 | P1 | MCP cancel / tool timeout = Interrupt | 分离：MCP/CLI 请求取消 ≠ `InterruptGrokBotAgentRun` | MCP transports/cancellation |
| 10 | P1 | poll 登录自称 device flow | 称产品自定义 PKCE-ish + poll；引 RFC8252/7636/9700 作 **安全实践**，非协议等同 | 鉴权报告；RFC |
| 11 | P2 | 大工具面一次塞满 | 借鉴 GitHub MCP **toolsets + read-only**；按 bot/message/sidebar/progress 分组启用 | github-mcp-server README |
| 12 | P2 | CLI/MCP 混用 stdout | CLI：stdout 数据 stderr 进度；MCP stdio 专用于 JSON-RPC，禁止夹带 CLI JSON | MCP transports；agent-cli-design / clig |
| 13 | P2 | Playwright/Chrome MCP 当同构对照 | 仅借鉴「MCP+CLI 双入口 / 风险声明」；**UI 自动化 ≠ Connect 原生 API** | 各自 README |

## Open questions（少问卷）

1. 「分组」是否确认 = SidebarSections？（计划默认是）  
2. create 对个人 bot：是否一律 `CreateGrokBotTemporalAgent` + TEMPORAL harness？（App 现路径倾向是；BOX harness 路径未完整静态追完）  
3. 0.78.4↔0.79.2：Create 请求字段 drift、RuntimeSettings 行为是否一致？（必须 S0）  
4. 服务端对 `sidebar_sections_base` 冲突的确切错误码/条件？（App 有映射；线上码待验）  
5. delete 后 sidebar 是否仍引用已删 agent_id？（观察项）  
6. 第三方身份政策是否允许独立控制面登录？（鉴权报告已标未验）
