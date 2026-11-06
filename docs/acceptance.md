# 验收

## 理念

**App 里人能完成且纳入范围的动作 → agent 经 MCP 与 CLI 可等价完成**（权限与人工确认仍由服务端/产品约束）。  
不验收「模仿点击」；验收**同一业务结果**（bot 存在、消息送达、状态可读、section 变更等）。

## 分层证据

| 层 | 含义 |
|---|---|
| 离线 / mock | 仅形状与双入口等价；**不是**交付 |
| 协议已映射 | 字段与 RPC 对照完成 |
| 真机（另授） | 真实登录后的读写；才算该能力完成 |

## 真机剧本（到时另授权；当前不执行）

1. auth whoami  
2. bot create → list 可见  
3. message send → send status / transcript 有进展  
4. bot status / todos 或 tasks 可读  
5. sidebar sections 更新（若确认分组=Sidebar）  
6. bot delete（dry-run → 确认删除）  
7. 同上剧本各跑一遍 **CLI** 与 **MCP**

## 防护

- 防误删；纯 dry-run  
- timeout ≠ 自动重发写  
- 取消/中断作用域说清  
- 无终态不强行 success  

## 旧仓

`grokbot-task-bridge` 的 mock 绿**不**计入本仓验收。
