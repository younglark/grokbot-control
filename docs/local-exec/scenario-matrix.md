# local-exec 场景验收矩阵（0.79.3 Linux，2026-11-08 Asia/Singapore）
> t107 第四轮：P2 cancel-behind-overflow（我们 busy ACK128、cancel 不可达）已修：closing 延迟改为字节+条数预算（≤1MiB/8192，原 128 条），最终代码 ours 4 次/官方 4 次探针全过，127 tests、46/36/10/0；有界内存下超预算洪泛仍会延迟控制（见 REVIEW-FIXES Round 4），待独立复验。
> t106 第三轮：上轮 rotation 独立复验**未通过**（独立 26 对 official 0 晚 / ours 3 晚；"400" 为 20+20 次运行的交叉配对数，非 400 次运行）。比较器 TICK-BOUNDARY 改为 UNRESOLVED 失败；根因为我方 250ms poll 定时器（官方无），改为 30s 安全轮询后 strict rotation 20 独立对全 SAME、124 tests、46/36/10/0。详见 REVIEW-FIXES.md Round 3，待独立复验。

> t103u 新批次（UC keepalive，d8b1d87/5bb3443 被审查阻塞 4×P2+P3 修正后，fa46d0f 再被阻塞 P2-1/P2-2/P3，本轮修正）：执行方自测，**待独立再审**；上一批 t101u 已独立验收并于 56ee14c push。
> 前批状态：t101u 第一批（e984310）独立验收未通过；d75f9f0/2ee10eb 修正后第二轮再审又提出 P2×5、P3×1，已在 10d37df（代码+回归）/5993cfa（门禁）修正；第三轮再审（eb79982）余 P2 init 进程组残留、P3 runner 未查 step 状态，已修复；第四轮 P2 PGID 复用误认领已以所有权句柄修正；第五轮 init timeout 回退已修正，**修正待独立复验**。npm test 98 pass；差分 46/36/10 不变。不宣称 drop-in。

证据等级：**实测** = 未修改的官方 `dist/local-exec-daemon/main.cjs`（asar 内 sha256 `5c1424ed…be`，与分析快照一致）在 bwrap 隔离 + 假 box SSE peer 下运行的帧；**静态** = 源码行号；**推断**；**未验证**。只覆盖已检查的 0.79.3 Linux 快照，不外推 macOS/Windows/其他版本。

## 1. App → daemon 启动（静态，`dist/electron-main/main-core.cjs`，从 app.asar 按 header 偏移读出）
| 项 | 证据 |
|---|---|
| 启动方式 | `M$e`：`utilityProcess.fork(entryPath,{env,stdio:"pipe",serviceName:"sand-local-exec-daemon"})` 后 `postMessage(handoff)`；无 utilityFork 时 `L$e`：`spawn(process.execPath, entryArgv, {detached, stdio:["ignore",log,log,"ipc"]})` + `send(handoff)`（offset ≈930256–930700）|
| env | `R$e`：`{...process.env, ...e.env, SAND_LOCAL_EXEC_GENERATION, NODE_USE_SYSTEM_CA:"1"}`，删除 `ELECTRON_RUN_AS_NODE`；`Kre` 额外注入 `SAND_LOCAL_EXEC_INHERITED_FDS` |
| handoff | `{type:"sand-local-exec-file-key", key, computerId}` |
| rg 配置 | App 主进程与 daemon 均无 `configureRipgrepPath` 调用；daemon 中 `Z2` 仅 5 处读取、无赋值（L19003–19015）；deb 内无 rg 二进制 → **实测** ls 报 `Ripgrep path not configured` |
| localRoot | `SAND_LOCAL_EXEC_ROOT` → `SAND_AGENT_PROJECT_DIR` → `homedir()`（静态）|
| cwd/参数 | utilityProcess 未传 cwd（推断继承 App cwd）；daemon 无命令行参数 |

## 2. 请求路由
- **实测**：box 通道 Hello 只报 `capabilities.messagesOpGeneration=4`；本地已注册并可执行：read、ls（报错）、shellStream；`grepArgs`/`writeArgs`/`deleteArgs` → `throw "No handler found for server message of type <case>"`；未知 oneof（如 `globToolArgs`）→ `type undefined`。
- **未验证**：云端对用户电脑实际会下发哪些 ExecServerMessage（无法离线证明）。不以 assistant 工具说明推断云端路由。
- 搜索：专用 Grep 本地不可达；Ls 可达但必报错；经 shell 调 `rg`/`grep` 依赖用户 PATH/登录快照（官方不补 rg）。

## 3. 差分结果（`scripts/oracles/r3`；统计以 diff.py 帧级比较为准）

2026-11-08 第二轮加固（5993cfa）：diff.py 改为**字段级窄规则**——`deviations.json` 每条规则固定 probe/case/帧序号/字段路径及官方与我们的**精确值**（op=field/drop/sub），规则不精确匹配即报错，规则外任何差异仍为 DIFF；校验 results 与 events 一一对应、case 集合等于 `expected-cases.json`、探针步骤全 pass、results 非空；run_r3.py 探针非 0/输出无效时非 0 退出。另跑我们侧 lifecycle 探针（shutdown 杀共享 init 进程组、emit 失败收尾）。`OUT=/tmp/r7 ./run_all.sh`（官方+我们各 8 个探针）实测 RC=0：

| 探针 | cases | same | allowed（规则 id）|
|---|---|---|---|
| main | 18 | 17 | 1（sh-ident：env-node-path）|
| cancel | 2 | 2 | 0 |
| cwd | 3 | 1 | 2（cwd-save/cwd-check，换行 cwd 安全）|
| edges | 13 | 9 | 4（multicwd/cwd-next 安全；path-save/path-read 原子性）|
| options | 2 | 2 | 0 |
| rootlink | 1 | 1 | 0 |
| locale | 5 | 2 | 3（unicode-cwd/unicode-next/spoof-check：同一换行 cwd 截断安全偏离）|
| cwdpersist | 2 | 2 | 0 |
| 合计 | 46 | 36 | 10（7 项原偏离 + 3 个 locale 探针中同类换行 cwd 偏离）|
| lifecycle（仅我们）| — | — | PASS |

门禁负向测试（test/oracle-gate.test.cjs，基于 `golden/` 录制结果）：缺 results、空 events、步骤失败、丢 case、results/events 不对应均非 0；10 个偏离 case 各自正向通过、替换为任意 throw 或改 exit.code 均失败；run_r3 缺 lab/不存在探针非 0。

以下为旧（宽松比较）记录：
命令：`OUT=/tmp/r3 python3 run_r3.py official-v2`；`... ours-v5 PROBE_MAIN=/repo/packages/local-exec-daemon/dist/index.js BIND:/workspace/grokbot-control:/repo`；`python3 diff.py official-v2.json ours-v5.json`。
| 运行 | same / diff |
|---|---|
| official-v2 vs official-v2b（官方自身重复性）| 18 / 0 |
| official-v2 vs ours@445ca90（ours-v2）| 9 / 9（ls、glob、sh-ident、sh-state1/2/3、sh-init、sh-plain2、sh-badcwd）|
| official-v2 vs ours@e984310（v5）| 17 / 1 |
剩余 1 个差异 `sh-ident`：官方多 `NODE_PATH=<官方安装 deps 目录>`（官方 bundle 自身产物）与空的 `__CURSOR_SANDBOX_ENV_RESTORE`，有意不模仿。

## 4. 场景矩阵
| 场景 | 状态 | 依据 |
|---|---|---|
| 启动/handoff/discovery | 部分 | 既有 Node IPC + Electron host-side 实测；非 asar 原位替换 |
| ls | 一致（实测）| `LsResult.error{path,error}` 文案逐字 |
| grep / write / delete / glob | 一致（实测）| No handler 文案与 `undefined` |
| shell：bash 选择 | 一致（静态 + 实测 SHELL 未设/设为 bash 两种）| `$SHELL` 含 bash，否则 PATH 查找；无则 `Can't find Bash` |
| shell：非 login、extglob、stdin=/dev/null、无 TTY | 一致（实测）| ARG0=`--`、LOGIN=0、EXTGLOB=1、CATRC=0 |
| shell：初始登录快照 | 一致（实测）| `.bash_profile`/`.bashrc` 的 export/函数/alias 生效、非 export 变量不生效 |
| shell：跨调用状态 | 一致（实测用例）| export/函数/alias/shopt 持久；`set -o` 持久但**排除 errexit/nounset/pipefail/posix**（官方过滤，oracle options-read）；非 export 不持久；`exit` 跳过保存；unset 传播；**cwd 跨调用持久**：未给 workingDirectory 时沿用上次最终 cwd（官方 golden cwdpersist：`cd sub` 后下次 `pwd`=sub），显式 workingDirectory 覆盖；沿用前重新做 root/realpath/symlink 校验，越界（如 `cd /tmp`）或已删除则回到 root；exit.cwd=最终 pwd；含换行的 cwd 只作为长度前缀数据，不进入脚本 |
| shell：请求级变量排除 | 一致（实测 vars-read）| CURSOR_REQUEST_ID/CONVERSATION_ID/AGENT_STORE、SUDO_ASKPASS、CURSOR_ASKPASS、CURSOR_SANDBOX*、*_proxy、POSIXLY_CORRECT、ELECTRON_RUN_AS_NODE 不跨调用（按变量名；官方按整行 grep）|
| shell：多行 alias / 引号值 / 特殊函数名 | 一致（实测 alias-read、quoted-read、func-read）| BASH_ALIASES + %q 序列化 |
| shell：首次快照期间取消/共享等待/shutdown | 一致（实测 cancel-init/check）| 入口登记；未 spawn 即 start+USER_ABORT；timeout 在 spawn 时起算（官方同）|
| shell：root 为 symlink | 一致（实测 rootlink）| 越界 symlink 仍拒绝 |
| shell：cwd 含换行 | **有意安全偏离** | 官方下一次调用执行 cwd 第二行（cwd-check=CWD_EXECUTED）且 exit.cwd 截断；我们 cwd 为长度前缀数据字段，不进脚本 |
| shell：快照原子性 | **有意偏离** | 完整 START/END+大小上限才提交；仅用 builtin。PATH=/nonexistent 时官方因缺 grep 保旧状态（LAST=unset），我们完整保存（LAST=x），函数/alias 两边都保留 |
| shell：坏 cwd | 一致（实测）| stderr 提示后在 root 执行 |
| shell：timeout / cancel | 一致（实测 timeout；cancel 有既有 lab oracle）| |
| shell：env 注入 | 部分 | 见 §3 剩余差异 |
| 并发 shell 状态写回 | 未验证 | 我们为最后完成者覆盖 |
| 状态脚本实现 | 独立实现 | 非官方 `dump_bash_state`，仅保证上述用例 |
| cwd 越界 | 未验证 | 我们仍拒绝（安全优先）|
| background / writeShellStdin / PTY | 未实现 | |
| Hello `standing` 字段 | 差异（实测）| 我们多发 `standing`，官方 box Hello 无；未改 |
| UC keepalive（t103u，待独立再审）| 仅 keepalive 子集曾对比 4 场景；本轮 7 场景（+pressure/rotation/stall-cancel）含数据语义对比，自测一致，已知偏差：exec heartbeat 未实现 | `scripts/oracles/uc-keepalive.cjs` + `keepalive-diff.py`：backlog（仅 backlog id 收 messagesAccepted，入队后约 1.47s 首次、+3.0s 再次；运行中请求不保活）、cancel（取消后停止保活，并发 "Cancelled before it started on the user's computer." throw）、stall（数据 submit 慢 7s 时 submitting id 保活）、exhausted（keepalive 429 resource_exhausted 后暂停 5s）。偏移容差 300ms |
| UC 数据 submit 超时 | 自测一致（与 keepalive stall 同证）| 原 2s 超时会每约 2.4s 重复提交同一帧；改为官方 E0=120s |
| UC 取消中断 submit / 凭据轮换隔离 / closing 背压 | 自测一致（stall-cancel、rotation、pressure、overflow 200 busy 全部 ACK=终帧）| replies.drop+submitAbort；rejectCredential 与 reply 失败点均按 channel 身份隔离；closing 帧同步入 lane 或有界延迟，否则不 ACK 留待重投；死亡门：daemon 中途死亡则场景/runner/比较器均非零 |
| UC 响应批处理 | **差异（未修）** | 官方一次 submit 可批多帧（stall 后 3 帧一批），我们每帧一次 submit |
| 审批 Ask/standing/scope、ack 持久、多账户 | 未实现/未验证 | 下一阶段 |
| headless/Docker | 未具备 | 需镜像自带 bash、可选 rg；无官方先例 |

## 5. 测试性质
- 有官方 oracle：`test/shell-review-fixes.test.cjs`（对比 `official-0793-oracle-r3-edges.json`）、`test/shell-oracle.test.cjs`、`exec-codec.test.cjs` 的 ls 用例（对比 `test/fixtures/official-0793-oracle-r3.json`，来自官方实测帧，已去 localExecutionTimeMs、路径归一）；`scripts/oracles/r3` 全进程差分。
- 自证：codec roundtrip、8/64、promote-before-admit 等。
