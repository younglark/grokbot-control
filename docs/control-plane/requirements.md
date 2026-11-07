# 需求（审查修订版）

## 产品定义

人通过 **Grok Bot App** 驱动 → 改为 **agent CLI 经 MCP/CLI** 驱动同一 Bot。  
可编程控制面 ≈ App 操作入口；**不是**另建任务系统。高层调度属上层 agent。

## 核心（不可降 P1）

1. Bot 生命周期：create / list / get(list筛) / update / delete  
2. 直接发消息 + send status + history + sessions  
3. 侧边栏分组（SidebarSections）CRUD/移动成员  
4. 进展：status / 原生 todos·tasks·subagents / interrupt  
5. MCP **与** CLI 同步  

Room ≠ 默认分组；TeamGroup 权限隔离另列。

## 非目标

全量 607 RPC；Admin/Internal/Vault；替代 Codex 等；UI 点击自动化（Playwright/CDP 类仅作双入口借鉴）；强制 taskID 账本。

## 与旧 task-bridge

保留参考；**停止作为产品交付**。吸取：勿用自建 task 状态机替代 CRUD/send。

细节矩阵 → [protocol-map.md](../protocol/protocol-map.md)；审查 → [review.md](review.md)；来源 → [references.md](../protocol/references.md)。
