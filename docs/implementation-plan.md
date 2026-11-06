# 实施计划（仅规划；本仓尚未实现）

原则：**用户明确的基础能力不得无声降级**；每期 **CLI + MCP 同步**（可结构上先 SDK 后适配，但**不是**把 CLI 或 MCP 降优先级）。  
未知语义列入「待确认」，不大问卷。

## S0 — 协议 / 鉴权兼容核验（另授登录后）

- 0.78.4 客户端 ↔ 0.79.2 后端冒烟：GetMe、`ListGrokBotAgents`  
- 独立浏览器登录 begin/poll/refresh 真机一次  
- 记录必需头与拒绝码  
**出口：** 只读链路可用说明；非产品功能完成。

## S1 — 共享 SDK + Bot CRUD（CLI+MCP）

- `bot list|create|get|update|delete`  
- dry-run / 删除确认  
- 参数语义双入口等价测试  
**出口：** App 级 bot 管理可编程；**仍须真机验收才算交付**（mock 不算）。

## S2 — 直接消息 + 会话/进展（CLI+MCP）

- `message send|status|history`（**无强制 task 桥**）  
- `session list`；`bot status|todos|tasks|subagents`；`interrupt`  
- timeout 不盲重发写请求  
**出口：** App 主对话闭环可编程。

## S3 — 分组两类（在确认后）

- **优先：** SidebarSections get/update（RuntimeSettings）  
- **并行文档化并实现独立命令：** Room（若产品需要多 bot 房）  
- TeamGroup 只读列表可作扩展  
**出口：** 侧边栏分组可编程；Room 不冒充分组。

## 可选 P1（不挡 S1–S2）

长任务观测辅助、本地幂等缓存、Streamable HTTP、watch 流封装。

## 明确停止

以旧 `grokbot-task-bridge` 为产品主线；把 CRUD/send 推后；用 mock 冒充 live MVP。
