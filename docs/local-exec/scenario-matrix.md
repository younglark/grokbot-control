# local-exec 场景验收矩阵（0.79.3 Linux，2026-11-08 Asia/Singapore）

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

## 3. 差分结果（`scripts/oracles/r3`，18 个用例；统计以 diff.py 帧级比较为准）
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
| shell：跨调用状态 | 一致（实测用例）| export/函数/alias/shopt/`set -o` 持久；非 export 不持久；`exit` 跳过保存；unset 传播；cwd 不持久，exit.cwd=最终 pwd |
| shell：坏 cwd | 一致（实测）| stderr 提示后在 root 执行 |
| shell：timeout / cancel | 一致（实测 timeout；cancel 有既有 lab oracle）| |
| shell：env 注入 | 部分 | 见 §3 剩余差异 |
| 并发 shell 状态写回 | 未验证 | 我们为最后完成者覆盖 |
| 状态脚本实现 | 独立实现 | 非官方 `dump_bash_state`，仅保证上述用例 |
| cwd 越界 | 未验证 | 我们仍拒绝（安全优先）|
| background / writeShellStdin / PTY | 未实现 | |
| Hello `standing` 字段 | 差异（实测）| 我们多发 `standing`，官方 box Hello 无；未改 |
| 审批 Ask、keepalive、ack 持久、多账户 | 未实现/未验证 | 下一阶段 |
| headless/Docker | 未具备 | 需镜像自带 bash、可选 rg；无官方先例 |

## 5. 测试性质
- 有官方 oracle：`test/shell-oracle.test.cjs`、`exec-codec.test.cjs` 的 ls 用例（对比 `test/fixtures/official-0793-oracle-r3.json`，来自官方实测帧，已去 localExecutionTimeMs、路径归一）；`scripts/oracles/r3` 全进程差分。
- 自证：codec roundtrip、8/64、promote-before-admit 等。
