# 剩余差异：逐项根因

依据：`/workspace/grokbot-node-analysis-0793/daemon.formatted.cjs` 的行号（D:），以及从 App 0.79.3 asar 静态提取的文件（当时放在 `/tmp/exec-t166-evidence/app-0793/`，临时目录，需要时按 [update-runbook](../protocol/update-runbook.md) 重新提取）。全部是静态读取，没有执行任何官方代码。
状态取值：**已修**（与原版一致，有测试）、**有意不移植**（附 App 不可达的证据）、**有意保留**（无线上效果）、**未移植**。
这是 local-exec 与原版差异的**总表**；新发现的差异写进 `evidence/<主题>.md` 后在这里加一行。

| # | 项 | 原版（D:） | 根因 / 我们的修复前行为 | 状态 |
|---|---|---|---|---|
| 1 | 矩阵 #48 handoff 容错 | Uae D:79679–79687；Lae D:79662；Bae D:79676；oqr D:187212；iqr D:187232–187283；v7t 5 s D:187193；cqr D:187302 | 修复前，第一条消息不合法就 fatal，且坏 key 直接 fatal。现在：非法消息被忽略；computerId 会 trim（≤127）；非 32 字节的 key 记为 null，并以明文服务；disconnect 或超时都按 null key 处理；finally 中执行 `process.connected && disconnect()`；无通道时用 env 的 preIpcFileKey，且不带 computerId，于是 fatal | 已修 |
| 2 | Linux 不可达：messages sidecar | Ed D:83034–83055：只查找 `.app` bundle（GROK_BOT_SIDECAR_APP、execPath 中的 `.app` 段、`sand/dist/native/sidecar/*.app`） | 我们的 locateSidecar 逻辑相同；Linux 上的结果是 `sidecar_missing` | 有意不移植（Linux 不可达） |
| 3 | Linux 不可达：macOS 本地工具 | 有 darwin 门控，并依赖 sidecar（vft D:132677） | Linux 上只走 "no tool" 分支 | 有意不移植（Linux 不可达） |
| 4 | 30 s 安全轮询只在 Watch 期间运行 | D:178388–178418：connected 时依次执行 requestPoll、flush、`d ??= safetyPoll.start(requestPoll)`；hc S9r = 30 s，leading，按完成时间锚定；在 watch 的 finally 中 dispose | 修复前是进程级定时器，断线期间也会 poll。现在每个 Watch 单独启动、结束时 dispose；connect 时 leading tick 与第一次 poll 背靠背（两次 poll），与原版相同 | 已修 |
| 5 | close 等待与提前结束 | awaitSettledOnClose 使用 ok = 10 s（D:97388、178081–178099）；`close gave up waiting for X: ${xt(qi)}`（qi D:78169）；submitAllOnClose 的日志为 `dropping N-frame response batch on close: ${xt}`（D:178128） | 文本已改用 xt 渲染（`DeadlineExceededError (deadline_exceeded)`）。另有一处差异有意保留：原版的 sleep（D:178324）不会被 close 唤醒，但计时器已 unref；我们会提前结束 sleep。线上帧没有区别 | 已修（文本）；sleep 提前结束：有意保留（无线上效果） |
| 6 | outageLedger | Z1t D:177641–177830、Y1t/W1t/K1t D:177571–177610、X8r D:177611、调用点 D:178018/178239/178261/178345/178390 | 修复前缺失。stdout 会写 `[user-computer-watch] <ISO> …` 行，outage ≥ 60 s 时写 `{"event":"sand.local_exec_daemon.watch_outage",…}`；App 的 main-core 会解析该事件做 telemetry，所以 App 可观测。现在已完整移植为 `src/uc/outage-ledger.ts`，包括字段顺序、5 s 监视、每分钟 still out、每小时 600 行上限和故障隔离 | 已修 |
| 7 | 设备工具（ot）nudge | D:179457–179460 读 local-device-tool-nudge.json 后调用 `q.watchForGrant` | Linux 上为 no-op：vft `supported = darwin && y5()`（D:132677），ppt `y = u && supported`（D:134895） | 有意不移植（Linux no-op） |
| 8 | presence-withdraw-failed 日志 | withdrawDeadline g9r = 750 ms（Gi/qi）；失败时发 onLoopEvent，lgt 打印 `[local-exec-daemon] user-computer presence withdraw failed: ${xt}`（D:179415–179419） | 修复前没有 deadline，也没有日志。现在 AbortController 加 750 ms 的 DeadlineExceededError，失败时发事件并打日志 | 已修 |
| 9 | 多账号与凭据生命周期 | Ve D:179343–179425：V map 每个 scope 一个 provider；Q 优先 userComputers（D:179250–179259）；scope 移除时 close 并 delete；SA 变化（原值 `===`）时 close 后重建；`Z && d && await C()`；inflight 计数按 "box" 与 `server:${scope}` 分键；Rt D:179462–179478 中 Ve 失败时记录 `standing re-hello check failed` 并 return，所有 provider 并行执行 rehelloIfChanged | 修复前只有单个 uc。现在 `ucProviders` Map 与原版语义一致；轮换使用 updateCredential（不重建）；rejectedAccountScopes 排序（D:179215）；ACK 持久化：原版不落盘，ackIds 只放在内存并在下一次 Poll 带出（矩阵 #17 已观测一致），因此无需移植 | 已修 |
| 10 | ownership / 关停语义 | pce 心跳 schema $Ft `{pid int>0, at}`（D:80881），默认 `{pid:0, at:0}`；tick 间隔超过 ITe（30 s）时 K = now + 90 s 容忍（D:179493–179512，FDe D:79881–79896）；hc tick 失败且不重试时只停止节奏（yre D:78466–78532）；原因文本 l$t（D:79742–79747）；I7t 2 s 上限后 exit 0（D:187191）；`discovery publish failed (previous record stands)` | 修复前：ownership 出错时 shutdown；原因文本缩写为 `received superseded`；没有 2 s 上限。现在全部按原版实现 | 已修 |
| 11 | 历史上间歇性的 ownership timeout | guard 读（D:179202–179207）之后才异步 write/rename（D:80644–80654），这是原版就有的非 CAS 窗口；另外 tn 读到撕裂或非法记录会返回 undefined，随后 `W?.pid !== pid && await C()` 触发 republish，两种实现都如此 | 根因有两个，叠加触发：测试 fixture 用非原子的 `writeFileSync`，可能被读到半截而触发 republish；或者 daemon 在途的发布覆盖了 fixture。两种情况下 daemon 都会继续认为自己是 owner，直到 20 s 超时。修复只改测试：fixture 改为 tmp + rename 原子写；被覆盖时重新写回，最多 5 次，并记录 trace。生产代码不变（与原版同样存在该窗口，由 uc-lifecycle 的 guard/rename 用例复现） | 已修（测试 fixture） |
| 12 | retry-expiry oracle 的随机波动 | silentRenewalBackoff 使用 Pu 全抖动，`random: e.random ?? Math.random`（D:177900–177906，Pu D:78223–78250，D:78241） | 第二次 Watch 重连落在 30 000 + j1 + random·上限 ms。落点早于最后一轮计划轮（约 31.7 s）时，帧会过期，结果变成 10 + 2 轮，而不是 11 + 1 轮。已复现：random = 0 时 watches 为 [359, 15370, 30375]，ours 有 2 轮 wake、37 次 attempts；random = 0.9 时 watches 为 [355, 17169, 35776]，1 轮 wake、34 次 attempts，与 golden 一致。修复只改测试：用预加载 `scripts/oracles/fixed-random.cjs`（`--require`），仅在 PROBE_MAIN 指向我们的 dist 且设置 PROBE_FIXED_RANDOM 时注入；retry-expiry 用例固定为 0.9 | 已修（oracle 确定化，生产不变） |
| 13 | 日志与错误文本扫查 | `channel resolve failed: ${xt}`（D:178229）；`dropping unparseable request frame: ${xt(o)}`（D:137506）；`… on close: ${xt(o)}`（D:178128）；UC hello label 为 `hostname().trim() \|\| "this computer"` | 修复前：前两处文本用 message 或 String 渲染；label 规则不同。现在统一使用 describeError（xt） | 已修 |
| 14 | abandonWork 取消路径 | D:178050–178064：通过 `executor.handle({kind:"cancel"})` 取消，失败时打印 `cancel failed for abandoned ${r}: ${xt}` | 我们的 cancelRequest 是同步调用，不会 reject，所以这条日志不可达；backlog 的 closing 帧相同（矩阵已观测） | 有意保留（架构差异，无线上效果） |
| 15 | crash guard | pTe/V7t D:78686–78712，cqr 最先安装 D:187290–187292 | 修复前未安装，未捕获异常会使进程退出。现在 `[sand-local-exec-daemon] <kind> (kept alive): ${xt}` 后继续运行；reporter 失败写 `sand.host.crash_reporter_failed` | 已修 |
| 16 | 关停清理 discovery | PLe D:81000–81004；`failed to clear discovery record on close: ${xt}` D:179530–179535 | 修复前无条件删除，可能删掉接任进程的记录。现在只删 pid 相同的记录，失败记日志 | 已修 |
| 17 | settings 全 schema 与 durable 日志 | II D:82217–82393；BDe D:79832–79875；tGt D:82208 | 修复前只校验我们用到的字段。现在任何兄弟字段非法即按不可读处理（ask），按 (path, kind, cause) 去重写 damaged/unsupported 日志。onDamage 后 rethrow | 已修 |
| 18 | shell 默认超时 | t5e / i5r = 30 s（D:130633） | 修复前 timeout=0 时永不超时。现在非后台请求默认 30 s | 已修 |
| 19 | Box exec 输出通道 | Box 构造同一个 v_（D:137251–137262），同步进入无界 outbox（D:137292–137294） | [close-stream.md](evidence/close-stream.md) 记录的阻碍（ReplyQueue 有界准入）已随 ba05d14 的无界 outbox 消失；Box 改用 Ki 通道，心跳持续到 producer finally | 已修 |
| 20 | Sentry 崩溃上报 | T7t D:187161；fatal `report(e,"fatal"); flush(1500)` | 缺失。需新增 `@sentry/node` 与 hre 脱敏移植 | **未移植**（默认不移植；方案见 [port-coverage.md](port-coverage.md) §6） |
| 21 | 后台 shell / timeoutBehavior BACKGROUND / hardTimeout | bE D:98540；E_ D:130800–131184；r5e D:130721；ZO/p1e | 已移植 soft→backgrounded、terminals 文件、hardTimeout、spawn、writeStdin。未做 forceBackground* / outputNotification registry | 已修；forceBackground/outputNotification/registry 经静态核验不可达，有意不移植（port-coverage §9） |
| 22 | denylist + requestedSandboxPolicy | Qk D:106788–106796；Kc D:106557；Ud/ol D:20797 | 已移植匹配/解析/fail-closed；Linux 无 helper → sandboxUnsupported | 已修 |
| 23 | ls 配置 ripgrep 后的树路径 | nl/Z2 D:19007–19015；b0 D:19002；LocalLsExecutor D:129392–129609；kO D:107439；yer D:107400；t9 D:132442 | 默认不变（未配置→同句错误）。配置后已移植 kO argv、Md env、Eer、预算树、timeout；b0 接入 shell env。后续补齐 CE、spawnWorkload、ls 外层取消 | 已修，见 [ls-ripgrep.md](evidence/ls-ripgrep.md) |
| 24 | exec spawn 统一走 Ko/Ud | Ko D:21094；Ud D:20798–20812；Md D:18901；CE D:19166；t$t D:16797；ZUt D:16758；_ae D:15327；eBt D:15440；BNe D:15066；handleCancel D:136353 | 修复前 shell 不做 Md、不合并 CE、无 cgroup/FUSE 跳转、不写 oom_score_adj；ls 无取消；计时器 unref。现在 ls/shellStream/backgroundShell/快照都经 Ko；ls 取消→timeout；去掉 unref。p6（z0e 从未赋值 D:107305）与 fer/ler（t9 恒 [] D:132452）不可达，只记录 | 已修 |

## 根因未知

无。

## 相关测试（`packages/local-exec-daemon/test/`）

| 文件 | 覆盖 |
|---|---|
| `t171-remaining-diffs.test.cjs` | outage ledger、channel-missing 去重、X8r、Uae 解析、IPC handoff |
| `t175-port-coverage.test.cjs` | crash guard、discovery 清理、settings 全 schema、shell 默认超时、pullOutput |
| `t176-background-denylist-sandbox.test.cjs` | denylist、sandboxUnsupported、BACKGROUND+hardTimeout |
| `t181-background-reachability.test.cjs` | 后台三组件不可达、jHt 文案 |
| `t196-ls-ripgrep-tree.test.cjs`、`t198-spawn-workload-ls-cancel.test.cjs` | ls/ripgrep 树、Ko/Ud spawn、ls 取消 |
| `uc-lifecycle` / `uc-keepalive` / `uc-close-channel` / `t162-uc-unauthorized-renewal` / `ownership-oracle` | 多账号、安全轮询、withdraw、ownership 文本（retry-expiry 固定 random 0.9） |

文件名里的 tNNN 是历史编号，保留不改。各轮修改说明见 [history/local-exec-evidence-rounds.md](../history/local-exec-evidence-rounds.md)。
