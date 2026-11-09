# 函数级移植覆盖审计（t175–t181 更新）

对象：0.79.3 原版 daemon bundle `/workspace/grokbot-node-analysis-0793/daemon.formatted.cjs`（下称 D:）与我们的 `packages/local-exec-daemon`。
方法全部为静态读取：没有执行任何官方代码、worker 或 App 内二进制。脚本与中间产物在 `/tmp/exec-t175/`。

## 1. 方法
1. `split2.py` 按花括号深度把 bundle 切成 10169 个单元（每个 var 声明子、function、class、顶层语句）→ `units.json`。
2. `jsstrip.py` 去掉字符串/模板文本（保留 `${}` 表达式）后抽取标识符引用；`reach2.py` 从入口块（D:187180 起，含 cqr/aqr）做可达性闭包，过滤局部名 → `units2.json`。
3. `modules.py` 按区段表把单元归入模块，并按签名标记第三方区段（见 §2）。
4. `classify.py` 对每个第一方可达单元判定：我们 src/test/docs 中的 `D:` 行号引用、最小化名引用、字符串常量是否出现、平台门控正则 → `classified.json`。
5. 自动结果之外的单元按模块逐一或按区段人工判定（§3、§4）。

## 2. 排除的第三方区段（按签名识别）
zod（1–7400）；npm CJS shim；OpenTelemetry；iconv/chardet；ajv；jimp/图像编解码；MCP SDK；semver/otel-semconv；
protobuf-es（85000–87500）；生成的 agent.v1 proto（87500–97000）与 aiserver proto（137500–172500）；connect-es/node/http2（172500–177500）；
minimatch；tar；RE2JS；Sentry SDK 与 https-proxy-agent（179470–186500）。

## 3. 统计（第一方、从入口可达的单元）
总计 **1955**。

| 类别 | 数量 | 说明 |
|---|---|---|
| 已移植-一致（有映射） | 556 | 548 个自动映射（402 行号引用 + 114 名称引用 + 32 字符串命中），另 8 个人工确认：j1t/sxe/egt/oxe/ngt/b9r（UC，`outage-ledger.ts`/`reply-lanes.ts`/`provider.ts`）、lee/N9r（`connection-exchange.ts`/`settings.ts`） |
| 已移植-差异（执行器层重写） | 531 | agent-exec 库（进程/shell 工具、sandbox/zsh/powershell、shell exec/后台 shell、git/env、read/ls/ripgrep、skills）。只经 v_ 执行器的 4 个注册项（Tp shellStream、bE backgroundShell、gk read、mk ls）可达，我们在 `src/exec/handlers.ts`/`shell-session.ts` 以执行器层重写；子差异见 §5 |
| 有意不移植（Linux 不可达） | 393 | 89 个平台门控命中 + sidecar/macOS native/bplist 62 + computer-use 85 + darwin 本地工具 150 + Box mdfind 应用查找 7（rmt/tmt/Swr/ywr/Ewr/smt/bwr，D:137112–137133） |
| MISSING（大项，给计划） | 79 | telemetry/redaction 区段：Sentry 崩溃上报 T7t 与 hre 脱敏（§6） |
| 辅助内部实现，未逐个核验 | 396 | core 179 / catalog 133 / wire 84 中的未映射单元：重试/中止错误类、routeString 深链目录、durable-file 辅助、otel 指标名、disposable stack、hook proto 表等。已对其字符串常量做缺失扫描，结果见 §4 |

MISSING 发现 4 项并已修复，另有 1 项“已移植-差异”在本轮修为一致（§4）。

### 按模块
| 模块（起始 D:） | 映射 | 平台门控 | 未映射 | 处置 | 我们的文件 |
|---|---|---|---|---|---|
| agent-exec 进程/shell 工具 13415 | 17 | 1 | 69 | 差异（执行器层） | exec/handlers.ts、exec/shell-session.ts |
| agent-exec sandbox/zsh/powershell 18726 | 13 | 13 | 135 | 差异；zsh/powershell 不可达（bash 选择已对齐） | exec/shell-session.ts |
| core：运行时/deadline/identity/sealed/discovery/ownership 78010 | 106 | 7 | 179 | 一致；本轮补 crash guard、PLe | bootstrap/crash-guard.ts、state/*.ts、index.ts |
| 本地工具目录/settings/审批/grants 80508 | 91 | 3 | 133 | 一致；本轮补 settings 全 schema 与 durable 日志 | settings.ts、approvals/*、local-tools/* |
| sidecar/macOS native 82976 | 13 | 14 | 62 | 有意不移植 | — |
| wire/AI-tool 发现/exec 注册 97006 | 90 | 2 | 84 | 一致 | exec/exec-codec.ts、ai-tool/*、exec/output-channel.ts |
| agent-exec sandbox 策略/shell exec/后台 shell 106326 | 12 | 1 | 172 | 差异；后台 shell、denylist、sandbox 为 MISSING 大项 | exec/handlers.ts |
| agent-exec git/env 117809 | 2 | 0 | 20 | 差异 | — |
| computer-use/截图 123055 | 2 | 0 | 85 | 有意不移植（macOS） | — |
| agent-exec read/write/ripgrep/ls 126597 | 4 | 0 | 83 | 差异（只 read/ls 注册） | exec/handlers.ts |
| agent-exec skills/misc 130633 | 1 | 0 | 52 | 差异；本轮补 t5e/i5r | exec/handlers.ts |
| 本地工具（reminders/calendar/notes/obsidian/location/cua）132525 | 106 | 44 | 150 | Obsidian 等跨平台项一致；其余 darwin 有意不移植 | local-tools/* |
| Box provider/stream 137103 | 14 | 2 | 7 | 一致（7 个为 darwin mdfind）；本轮 Box 接入 Ki | box/provider.ts |
| UC provider + outage ledger 177511 | 51 | 0 | 6（已人工确认） | 一致 | uc/*.ts |
| daemon main lgt 179109 | 9 | 0 | 2（已人工确认） | 一致 | index.ts、state/* |
| telemetry/redaction + 入口 186528 | 17 | 2 | 79 | 入口一致；Sentry MISSING 大项 | index.ts |

## 4. 本轮修复（与原版一致，有测试 `test/t175-port-coverage.test.cjs`）
| # | 项 | 原版 | 修复 |
|---|---|---|---|
| M1 | 进程级 crash guard | pTe/V7t D:78686–78712，cqr 中最先安装（D:187290–187292）：uncaughtException/unhandledRejection 记录 `[${scope}] ${kind} (kept alive): ${xt}` 后进程继续；reporter 抛错时 stderr 写 `sand.host.crash_reporter_failed kind=… error_class=…` | 新 `src/bootstrap/crash-guard.ts`，`main()` 第一步 `installCrashGuard("sand-local-exec-daemon")` |
| M2 | 关停时只删除自己的 discovery 记录 | PLe D:81000–81004（读失败放行、rm force）；lgt close 失败日志 `[local-exec-daemon] failed to clear discovery record on close: ${xt}`（D:179530–179535） | `clearOwnDiscovery(pid)` 取代无条件 `clearDiscovery`；shutdown 记录同文本 |
| M3 | settings 完整 schema 与 durable 文件日志 | II D:82217–82393：zqt + jUe 全 schema 校验失败即不可读 → aue 默认（ask）；BDe（D:79832–79875）按 (path, kind, cause) 每进程去重：`durable file damaged path=settings.json cause=${xt} copy=none`、`durable file unsupported path=settings.json version=N`（tGt D:82208） | `src/settings.ts` FullSettingsSchema（zod/v4，枚举 tI/IUe/CUe/OUe/NUe/iue 等）、report/reportUnreadable |
| M4 | shell 默认超时 | t5e：`timeout !== 0 ? timeout : (isBackground \|\| timeoutBehavior===BACKGROUND \|\| hardTimeout>0) ? 0 : i5r`，i5r = 30 000（D:130633） | `shellTimeoutMs()`；修复前 timeout 为 0 时永不超时 |
| F1 | Box 接入 Ki 输出通道 | Box 同样构造 v_（D:137251–137262），结果同步进入无界 outbox（enqueue D:137292–137294） | Box 已是同步无界 outbox（ba05d14），原阻碍（ReplyQueue 有界准入）不复存在；`dispatchExec({pullOutput:true})`，心跳持续到 producer finally，与 UC 一致 |
| M5 | t176 settings 读错误 rethrow | II.readText D:82258–82270 | 非 ENOENT/ENOTDIR：onDamage 后 throw（不再回退 ask） |
| M6 | t176 后台 shell | E_ / r5e / ZO / p1e / bE | 见 §6.2；测试 `t176-background-denylist-sandbox.test.cjs` |
| M7 | t176 denylist + sandbox | Qk D:106788；Ud/ol D:20797 | 见 §6.3–6.4 |

## 5. 旧待办复核
- **Ki 边界**：已实现。`src/exec/output-channel.ts` 移植 Ki（D:14896–14972）与 wE 心跳（98141–98193）；UC 早已接入，本轮 Box 也接入（F1），legacy `withExecHeartbeat` 只剩直接单元调用者使用。
- **文件 attached sources**：UC download 的 oee 附加源已实现（见 uc-download-evidence.md）。Box 原版是整文件物化（enqueueWholeFile/iqe，D:137505–137535），我们一致（upload-box-url-evidence.md）。exec 流本来就不挂 oee（close-stream-evidence.md）。

## 6. 大项计划 / t176 已修
1. **Sentry 崩溃上报**（T7t D:187161）— **仍 MISSING**（本轮按任务要求不动）。计划不变：`@sentry/node` + hre 脱敏；仅两 env 均设置时 init；fatal `report+flush(1500)`。
2. **后台 shell** — **t176 已修**：`timeoutBehavior=BACKGROUND` 软超时 → `backgrounded`（D:131146–131184）+ `terminals/{id}.txt`（p1e D:110252）；`hardTimeout` 在转后台后仍可 abort（D:131055–131065）；`backgroundShellSpawnArgs`（bE/$3 D:110633）。shellId 范围 1000–999999（YO/u1e）。`writeShellStdinArgs` / `forceBackgroundShellArgs` **不在 Tft 注册表**（D:132615–132670 仅 Tp/bE/gk/mk）→ 原版 No handler，我们保持一致；ZO.writeStdin 仅作后台管理器内部 API。剩余三个组件经 t181 静态核验均不可达，不移植（见 §9）。
3. **管理员命令 denylist** — **t176 已修**：`src/exec/denylist.ts` 移植 Qk/vhe/zje/hZt/ZE/fZt/Gje/mZt/Mg/lse/bb/R4（D:106650–106796）与 m3/GYt 可执行命令抽取（D:99470–99750）；tree-sitter 可用时精确解析，不可用时 fail-closed fZt。
4. **requestedSandboxPolicy** — **t176 已修**：Kc（D:106557）+ Ud/ol（D:20797–20834）。Linux 无 helper → `sandboxUnsupported`（Binary check failed）。不移植 darwin-only HKt/uze。start.sandboxPolicy 使用请求的策略（Xk 语义）。
5. **settings 非 ENOENT 读错误** — **t176 已修**：II.readText（D:82258–82270）onDamage 后 rethrow（pue 无 isRefusedRead）。

## 7. 字符串常量核对（可达部分）
- UC：Q8r/X1t/r9r/Q1t/n9r/A9r/ngt 在 `uc/provider.ts`；sxe/egt/o9r/i9r/oxe/a9r/E0/Gpe 与 b9r 关闭事件集合在 `uc/reply-lanes.ts`；j1t 在 `uc/outage-ledger.ts`。
- 新增覆盖：`(kept alive)`、`sand.host.crash_reporter_failed`、`failed to clear discovery record on close`、`durable file damaged/unsupported`。
- 死常量（声明但无引用）：ein/tin/rin/nin/sin/oin/iin（D:81194–81202）——不移植。
- `sand.local_exec_daemon.invariant_violation`（CDe）：App 只解析 `watch_outage`，有意不移植。
- 残余 396 个单元的缺失字符串扫描只命中错误类名、深链目录校验文本、otel 指标描述、`The … file is unreadable.` 系列（我们以 damaged 回退表达，不输出原文）、tree-sitter 降级警告——均不在 Linux 上的线上帧或 App 可解析输出中。

## 8. 依赖（t177）
denylist 解析直接 `require("tree-sitter")` / `require("tree-sitter-bash")`（`src/exec/denylist.ts`），对应 `packages/local-exec-daemon/package.json` 正式依赖：
- `tree-sitter@0.21.1`（公开 npm；与 App 随包 `@cursor/node-tree-sitter` 0.21.1 同 API/版本号）
- `tree-sitter-bash@0.21.0`（公开 npm，与 App `dist/deps/tree-sitter-bash` 同版本）
`node-gyp-build` 是 tree-sitter 的传递依赖，代码未直接 require，不单独声明。workspace 根 `package.json` 的 `allowScripts` 批准二者的 install 脚本以便 npm 拉取/重建 prebuild natives；**不**从 App asar 拷贝 `.node`。解析失败仍 fail-closed 到 fZt（与原版 tree-sitter stub 路径一致）。

## 9. 后台三组件可达性（t181，静态）
| 组件 | 原版 | 可达性证据 | 结论 |
|---|---|---|---|
| forceBackgroundByToolCallId（USER_REQUEST 转后台） | E_.forceBackgroundByToolCallId D:130809–130819；requestBackground D:130775、131033 | bundle 内无任何调用点（`grep \.forceBackgroundByToolCallId` 仅定义处；`pendingFrom` D:130820 同样无调用）；唯一可能入口 forceBackgroundShellExecutor（D:99280）**未在 Tft 注册**（D:132615–132670 仅 Tp/bE/gk/mk）→ 线上 `forceBackgroundShellArgs` 回 `No handler found …`（wE D:98199–98201） | 不可达，不移植；测试钉住 No handler 回复 |
| outputNotification 观察器（l1e） | d1e.createObserver D:109931–109955；l1e D:109714 | Tft 以 `new $3(r,o,n,t,void 0,void 0)` 构造（D:132609）→ `$3` 中 `u = i && …: i` 为 undefined（D:110623）→ `new d1e(l,s,u)` 的 backgroundWorkRegistry 为 undefined → createObserver 首行 `if (!this.backgroundWorkRegistry …) return;` 永远返回 | 不可达，不移植；测试确认带 outputNotification 的 spawn 只写 `terminals/{id}.txt` |
| backgroundWorkRegistry 完成队列 | ZO.registerShellWork/clearShellWork/enqueueShellCompletion D:110401–110450 | 同一 `u` 传给 `new ZO(d,u)`（D:110626）；三处均为 `this.backgroundWorkRegistry?.…` 或 `if (!this.backgroundWorkRegistry) return;` → no-op；且队列只在进程内（无 wire/磁盘/日志输出） | 不可达且无可观测效果，不移植；测试确认转后台后无任何完成帧 |

App 侧：0.79.3 asar 中这些符号只出现在 `/dist/local-exec-daemon/main.cjs`（即 daemon bundle 本身）；main.cjs / main-core.cjs / main-app.cjs / proto.cjs（`/tmp/exec-t166-evidence/app-0793/`）均 0 次。App 不经 IPC 触发它们。

顺带修复（同一 wE 分支，范围外但可观测）：jHt（D:98041–98046）为 `computerUseArgs` / `recordScreenArgs` 给出固定拒绝文案，原先我们回通用 `No handler found …`。已改为原文，测试 `t181-background-reachability.test.cjs`。

