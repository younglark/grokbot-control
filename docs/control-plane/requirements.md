# 控制面需求与验收

## 产品定义

原来人在 **Grok Bot App** 里操作；现在让 **agent 通过 MCP / CLI** 驱动同一个 Bot。
控制面 ≈ App 的操作入口，**不是**另建任务系统；高层调度属于上层 agent。

## 核心能力（不可降级）

1. Bot 生命周期：create / list / get（list 后筛选）/ update / delete
2. 直接发消息 + send status + history + sessions
3. 侧边栏分组（SidebarSections）CRUD、移动成员
4. 进展：status / 原生 todos·tasks·subagents / interrupt
5. 电脑：state / reset（含 `--hard`、`--wait`）
6. MCP **与** CLI 同步提供，语义等价

Room ≠ 默认分组；TeamGroup 权限隔离另列。「分组」语义目前暂搁置在 SidebarSections。

## 非目标

全量 RPC；Admin / Internal / Vault；替代 Codex 等；UI 点击自动化；强制 taskID 账本。旧的 task-bridge 只作参考，不再作为产品交付——不要用自建 task 状态机替代 CRUD / send。

## 验收场景（真机需另行授权）

原则：App 能做且在范围内的事，MCP 与 CLI 都要能等价完成（保留服务端权限和人工确认），不模仿 GUI。

1. 独立 test bot：create → list/get 可见
2. send → send_status / history 有进展（delivery ≠ 业务成功，分开报告）
3. status / todos 或 tasks 可读；interrupt 需确认
4. sidebar：改 sections → 读回 verify；故意冲突 → conflict；**删 section 后 bot 仍在**
5. delete 需 confirm；token 过期 / 组织策略拒绝路径
6. 丢失 send 响应 → `unknown`，禁止自动重发
7. 同一剧本 CLI 与 MCP 各跑一遍；无 TTY + `--json`
8. computer：state 只读；reset 缺 `--confirm=RESET_COMPUTER` / `--allow-writes` → denied；`started=false` → failed_precondition；`--wait` 阶段序列；等待超时 → unknown / exit 10；`--hard` 走 `ForceRecreateSandBox`

证据分层：mock / 离线 ≠ 交付；协议映射 ≠ 交付；真机验证通过才算该能力完成。

相关：契约矩阵 [protocol-map.md](../protocol/protocol-map.md)；设计审查存档 [history/control-plane-design-review.md](../history/control-plane-design-review.md)；资料来源 [references.md](../protocol/references.md)。
