# 场景矩阵各轮记录（历史）

> 存档：原 `docs/local-exec/scenario-matrix.md` 顶部的逐轮自测/复验说明（t103u–t113u）和旧版宽松比较记录，原文未改。文中提到的 `REVIEW-FIXES.md` 现在是 [local-exec-review-rounds.md](local-exec-review-rounds.md)。当前状态以 [scenario-matrix.md](../local-exec/scenario-matrix.md) 为准。

## 逐轮说明

> t108u–t113u（执行方自测，非独立验收）：设置按原版逐请求同步读取；接纳/shell 前 await 边界对齐原版（心跳计时器不再被首个 shell 同步准备拆开）；UC 权限拒绝改为 control throw{id:0}、不占 execId、先于取消判断；throw cwdState 按原版 Aft（exists/missing/省略/unset）。审批与 serverAuthoritative 授权未实现；3 个官方二进制用例本轮跳过。详见 REVIEW-FIXES.md。
> t112 第九轮（待独立复验）：实现官方 exec heartbeat（3s，写完再排下一次，失败吞掉，完成/取消/shutdown 清计时器）；严格 fair 门禁暴露 start 帧顺序差异并修正（spawn 前发 start、设置读取 FIFO、同步 stat）；check-mechanism 改为官方 retry/backoff 模型+Watch 唤醒证据，无 collapse；hb-hold 对照串行 6/6 一致，负载下 ours 更常在 KA 中带运行中 exec（未解决）；overflow 启动失败未复现，仅加诊断未延 deadline。历史 6380 提交为 stdout 非 exit，已更正。
> t111 第八轮（待独立复验）：撤销 t110 的 flushRequested 粘滞标记（它使 3 次失败后 500ms closing 退避刚排程即被立即重提，恢复延迟 2–3ms；官方 504ms）。flush 改为官方状态机：flushing 互斥、循环内每轮重读状态、kept>0 且 readyCount===kept 时排程退避并返回；Watch connected→flush。retry 原版探针恢复延迟 504/505/504ms（官方 504/505/503）。check-mechanism 改为显式归一化 localExecutionTimeMs 后逐帧全内容比较 + attempt↔accepted 交叉校验 + 257 lane 身份/计数/逐批序列，8 负向全 FAIL。backlog 全量并行失败（第三个 KA [sh3,sh8]）保留未掩盖：串行 8+8 与并发负载 9+9 均未复现；推断源于范围外的 heartbeat 缺失（官方 heartbeat 在 ~3.3s/6.3s 刷新 sh3 的 heard，ours 不发，sh3 在退出突发回复在途时已过期，若 500ms KA tick 落入在途窗口即被纳入），未修改测试隔离调度。
> t110 第七轮：独立复验关闭 retry/fair；新 P2——401 后两层 microtask 的 resume 被 flush 互斥吞掉，回复停滞到下一次入队才用新 credential 发出（3/3 复现）。现挂起 flushRequested，当前 flush 结束后兑现，connected 也 resume；比较器当时仅校验身份/帧类型/尝试存在与公平批次总量（t110 独立复验指出仍有 5 个负向意外 PASS，并非完整帧内容比较，已在 t111 更正）。rotation 作者原第 4 对 FAIL 保留，本轮独立对如实计数。不宣称 drop-in。
> t109 第六轮：t108 只对齐了存储机制，重试/丢帧与跨批 lane 顺序仍不同（独立 review 发现两处 P2）。现按原版实现 UcReplyLanes：每批 3 次、间隔 200ms，耗尽后只保留关闭终帧（30s 预算，从首次提交起算），closing 退避 500ms→4s，lane 顺序跨批保留，取过的移到尾部，失败的放回队首。仅 UC，Box 未改。评审探针和新增 golden 一致；rotation 5 对中有 1 对 strict 失败，原因未明，详见 REVIEW-FIXES Round 6。不宣称整个 UC 或 drop-in。
> t107 第四轮更正：当时仅为 200 例容量缓解，原 P2 未关（520×1024 超预算仍堵），且 cancel 预留按估算导致 backlog 终帧丢失（已在 t108 修为原子）。t108 第五轮：按用户要求与原版一致——原版 reply 队列（oee）按请求分 lane、内存无上限、单次 take 256 帧/8MiB、全部 ACK；我们在存储层面改为同机制（当时重试/顺序尚不同，见 t109；无界存储、轮转取批、poll limit 64）。520 长 ID/cancel、backlog 终帧、200 例探针官方/我们均通过，133 tests、46/36/10/0。风险同原版：后端卡住时回复内存无界。待独立复验。
> t106 第三轮：上轮 rotation 独立复验**未通过**（独立 26 对 official 0 晚 / ours 3 晚；"400" 为 20+20 次运行的交叉配对数，非 400 次运行）。比较器 TICK-BOUNDARY 改为 UNRESOLVED 失败；根因为我方 250ms poll 定时器（官方无），改为 30s 安全轮询后 strict rotation 20 独立对全 SAME、124 tests、46/36/10/0。详见 REVIEW-FIXES.md Round 3，待独立复验。
> t103u 新批次（UC keepalive，d8b1d87/5bb3443 被审查阻塞 4×P2+P3 修正后，fa46d0f 再被阻塞 P2-1/P2-2/P3，本轮修正）：执行方自测，**待独立再审**；上一批 t101u 已独立验收并于 56ee14c push。
> 前批状态：t101u 第一批（e984310）独立验收未通过；d75f9f0/2ee10eb 修正后第二轮再审又提出 P2×5、P3×1，已在 10d37df（代码+回归）/5993cfa（门禁）修正；第三轮再审（eb79982）余 P2 init 进程组残留、P3 runner 未查 step 状态，已修复；第四轮 P2 PGID 复用误认领已以所有权句柄修正；第五轮 init timeout 回退已修正，**修正待独立复验**。npm test 98 pass；差分 46/36/10 不变。不宣称 drop-in。

## 旧（宽松比较）记录

命令：`OUT=/tmp/r3 python3 run_r3.py official-v2`；`... ours-v5 PROBE_MAIN=/repo/packages/local-exec-daemon/dist/index.js BIND:/workspace/grokbot-control:/repo`；`python3 diff.py official-v2.json ours-v5.json`。
| 运行 | same / diff |
|---|---|
| official-v2 vs official-v2b（官方自身重复性）| 18 / 0 |
| official-v2 vs ours@445ca90（ours-v2）| 9 / 9（ls、glob、sh-ident、sh-state1/2/3、sh-init、sh-plain2、sh-badcwd）|
| official-v2 vs ours@e984310（v5）| 17 / 1 |
剩余 1 个差异 `sh-ident`：官方多 `NODE_PATH=<官方安装 deps 目录>`（官方 bundle 自身产物）与空的 `__CURSOR_SANDBOX_ENV_RESTORE`，有意不模仿。
