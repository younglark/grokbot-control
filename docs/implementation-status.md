# 实现状态（本地，2026-11-07 Asia/Shanghai）

| 能力 | CLI | MCP | Connect | 测试 | Live |
|---|---|---|---|---|---|
| bot create (Temporal) | ✅ | ✅ create_bot | ✅ | ✅ mock+schema | ❌ 未验 |
| bot list/get(list筛) | ✅ | ✅ | ✅ | ✅ | ❌ |
| bot update/delete+confirm+dry-run | ✅ | ✅ | ✅ | ✅ | ❌ |
| message send（无 task id） | ✅ | ✅ | ✅ | ✅ | ❌ |
| send status / history / sessions | ✅ | ✅ | ✅ | ✅ | ❌ |
| progress status/todos/tasks/subagents/interrupt | ✅ | ✅ | ✅ | ✅ mock | ❌ |
| SidebarSections CRUD/move + base | ✅ | ✅ | ✅ | ✅ conflict | ❌ |
| 文件快照 sync pull / status / render | ✅ | ✅ 启动配置 root + 独立本地写开关 | ✅ 只读 List RPC | ✅ mock/generated transport/FS 恢复 | ❌ 未验 |
| sync attachments（按需 user-attachment） | ✅ | ✅ sync_attachments（同本地写开关） | ✅ ResolveGrokBotAttachmentReads + HTTPS GET | ✅ mock | ❌ 未验 |
| Room | unsupported | — | — | — | — |
| Auth login-begin/complete/poll/refresh/logout（证据驱动，静态逆向） | ✅ | ✅ login_begin/complete/cancel/logout | ✅ | ✅ fake fetch + 本地 fake 后端跨进程 | ✅ 真实浏览器登录 + 只读 RPC（bot list/sidebar list/status）一次人工验证；❌ refresh（需配置 client_id）与写操作未 live 验 |
| unknown 丢响应 / 不盲重试 | ✅ | ✅ | ✅ | ✅ | — |

`simulated: true` 仅 mock。

协议 vendor：App **0.79.3**（2026-11-07 本仓库从App恢复生成）。上表 Live ✅ 一行是在**旧 0.78.4 vendor** 下完成的；0.79.3 vendor 仅离线验证（`verify_generated.mjs` + `test/proto-vendor-contract.test.ts`），未 live 调用。除 sync 无损归档保留的原始字段外，0.79.x 新增字段仍未暴露为独立 SDK/CLI/MCP 能力。

同步首版（详见 [sync-format.md](sync-format.md)）：CLI/MCP 共用 SyncOps；session-aware 原始 entry JSONL，
uint64 字符串/bytes base64、generation 分隔；只做有界重拉合并，不是 Watch 增量/完整备份。
identity assurance=operator_asserted_unverified，不能自动检测凭据换账户。
已基于 0.79.3 coordinator 的 TextDecoder -> JSON.parse -> Are/_b 路径支持 message、send-message(text)、
notice、tool-call name/status/summary、user-attachment 引用的可读 Markdown；未知/省略/blob-only 仍 opaque。
无通用卡片解码/解密、无 blob_hash 正文补读、无 --all。按需附件下载见 sync attachments（未 live 验证）。证据见 [transcript-body-0.79.3.md](protocol/transcript-body-0.79.3.md)。
原 message.history 修正 entryKind/bodyOmitted 映射，不改变摘要 API 或假称已能导出明文。

本轮离线验证：`npm test` 109/109；`npm run test:protocol-tools` 5/5；`npm run build`、`npm run typecheck`、`git diff --check` 通过。
含按需附件 mock（Resolve + HTTPS GET、幂等跳过、not_in_store、MCP 写开关/READONLY）。未 live 调用生产。
包含 CLI 子进程、MCP stdio、generated Connect mock、uint64/未知 wire 字段、
分页/代际变化/重拉合并、身份不匹配、锁/权限/路径、崩溃检查点恢复测试。
未调用真实同步 RPC；不表示生产分页/身份/消息解码已验证。
