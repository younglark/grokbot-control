# 架构

## 定位

```
人 / 上层 agent CLI（拆需求、编排）
        │
        ├── MCP（stdio 等）  ─┐
        └── CLI `gbc`（示意）─┴──► 共享 SDK
                                      ├── Credential provider（独立 store + refresh）
                                      ├── Connect 客户端（GrokBotService / Dashboard 必要方法）
                                      └── 按操作直接调用 RPC（bot/message/session/sidebar…）
                                               │
                                               ▼
                                          Grok Bot 后端
```

- **薄适配**：CLI 与 MCP 只做参数/结果形状转换，业务语义同一套。  
- **默认可无持久化任务账本**：凭据存储除外；基础 list/send 不依赖本地 queue/daemon。  
- **可选 P1**：对长等待的观测辅助、幂等缓存、聚合「工作项」——**不得**成为 send/CRUD 的必经之路。

## 与「任务调度」关系

上层 agent 的任务拆分是**调用方工作流**。本控制面暴露的是 App 同级的 bot 操作。  
旧 task-bridge 的 bridge_task 状态机**不**作为本架构中心。

## 安全边界

- 独立登录；Cursor / xAI 种类显式区分  
- token 不进 argv / 日志 / MCP tool 结果  
- 宿主 MCP OAuth ≠ Grok Bot 执行身份  
- dry-run 纯无副作用；删除需显式确认  
- 不暴露 Admin/Internal/Vault 明文；无 auto-approve  

## 非目标

另造对话 agent；全量 607 RPC 导出；假扮官方 CLI 名。
