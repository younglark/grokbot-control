# 验收（细化）

## 理念

App 能做且纳入范围 → MCP 与 CLI **等价完成**（保留服务端权限/人工确认）。不模仿 GUI。

## 必含场景（真机另授；本轮不执行）

1. 独立 test bot：create→list/get 可见  
2. send→send_status/history 有进展（delivery≠业务成功分列）  
3. status/todos 或 tasks 可读；interrupt 需确认  
4. sidebar：改 sections→读回 verify；故意冲突→conflict；**删 section 后 bot 仍在**  
5. delete confirm；token 过期/组织策略拒绝路径  
6. 丢 send 响应→unknown，禁止自动重发  
7. 同剧本 CLI 与 MCP 各一遍；无 TTY + `--json`
8. computer：state 只读；reset 缺 `--confirm=RESET_COMPUTER`/`--allow-writes` → denied；`started=false` → failed_precondition；`--wait` 阶段序列；等待超时 → unknown/exit 10；`--hard` 走 `ForceRecreateSandBox`

## 证据分层

mock/离线 ≠ 交付；协议映射 ≠ 交付；真机 = 该能力完成。
