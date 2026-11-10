# local-exec-daemon 替换验收矩阵

Harness：`packages/local-exec-daemon/test/dropin-acceptance.test.cjs`，辅助模块 `test/helpers/dropin-backend.cjs`。
它启动**我们构建出的** `dist/index.js`，对接一个合成后端，覆盖：生成的 Connect `GrokBotService`
（Watch/Poll/Submit/Withdraw）、Box JSON/SSE 通道（`/local-exec/requests`、`/local-exec/responses`）、
plain-HTTP 的 `/sand-box/local-exec-connection`。凭据、HOME、数据目录、审批文件、peer 全部是合成的；
官方的 main.cjs、二进制、worker 一律没有运行（`UC_SKIP_OFFICIAL=1`）。

- 门控：设 `DROPIN_ACCEPTANCE=1` 才运行，否则 skip。
  t165 版本约 53–55 s；t166 扩展后一次 75.5 s（`/tmp/exec-t166-evidence/final`）。
  其中包含真实的 15 s 静默 watchdog（t9r，D:177837）、两次 10 s channelRetry（Q1t，D:177841/177925）和 1/2/4 s reconnect（Q8r，D:177834）。
  原版这些计时器都没有 env 覆盖，所以不能缩短。在全量并行套件里，真实计时器容易被负载拖慢，因此不纳入默认套件。
- 证据：`DROPIN_EVIDENCE_DIR=<dir>` 会写出 `observed.json`，含每一步的观测值、后端事件时间线和 daemon 日志尾部。
  证据在 `/tmp/exec-t165-evidence/run{1..5}` 和 `/tmp/exec-t166-evidence/{dev1,final}`。（`/tmp/...` 下的证据目录都是当时的临时目录，可能已被清理；需要时按文中方法重新生成。）
- 启动方式：用 `spawn(process.execPath,[dist/index.js],{detached:true,stdio:['ignore',log,log,'ipc'],cwd})` 启动，
  再 `send({type:'sand-local-exec-file-key',key,computerId})`。这对应 App 的 fallback L$e。
  环境变量取 R$e 的形状：`SAND_LOCAL_EXEC_GENERATION`、`NODE_USE_SYSTEM_CA=1`，并去掉 `ELECTRON_RUN_AS_NODE`。
  以上依据来自静态读取的 main-core.cjs，见 [scenario-matrix.md](scenario-matrix.md) §1；t166 已对照 0.79.3 asar 中的 main-core.cjs 核实，见下文。

## 第二个门控 harness
`packages/local-exec-daemon/test/dropin-extra.test.cjs`，同样由 `DROPIN_ACCEPTANCE=1` 门控；辅助模块 `test/helpers/dropin-launch.cjs`、`test/helpers/ai-tool-fixture.cjs`、`test/helpers/electron-utility-host.cjs`。
- network-change：自身用 `unshare -rn node <file>` 重新执行（非特权 user+net namespace），在里面加真实 veth/地址；需要 `unshare` 可用。
- Electron：`DROPIN_ELECTRON=<npm 公开 electron 二进制>` 才跑；有 `xvfb-run` 时额外跑 `utilityProcess.fork`。**从不使用 App 自带的 electron。**
- 证据写到 `DROPIN_EVIDENCE_DIR`：netns.json、box-heartbeat.json、discover-{uc,box}.json、mb-*.json、electron-headers.json、node-proxy.json。t168 证据在 `/tmp/exec-t168-evidence/{dev1,final}`。

## 汇总

| 类别 | 数 |
|---|---|
| 一致 | 41 |
| 差异·破坏替换（已修） | 7（F1 t165、F2 t165、F3 t166、F4 t168、F5 t168、F6 t169、F7 t171） |
| 差异·可观测但无害 | 0 |
| 差异·仅内部（App 下不可达，未修） | 0 |
| Linux 不可达 | 2 |
| 未验证 | 0 |

矩阵之外的剩余差异（安全轮询生命周期、outageLedger、多账号、ownership 容忍、日志文本等）逐项根因见 [remaining-diffs.md](remaining-diffs.md)。
函数级覆盖审计（[port-coverage.md](port-coverage.md)）另修了 crash guard、PLe、settings 全 schema、shell 默认 30 s 超时、Box 接入 Ki 通道，以及后台 shell、denylist、沙箱策略。这些都不改变上表 48 行的结论。仍未移植：Sentry 崩溃上报。

## 逐步对照

| # | 步骤 | 原版预期（D:） | 我们的观测 | 类别 |
|---|---|---|---|---|
| 1 | IPC 交接后启动 | 收到 handoff 后 lgt 开始服务（D:187316–187322） | 打印 `started … serving`，并发布 discovery | 一致 |
| 2 | discovery 文件 | plain JSON；字段 filesKeyId/generation(int)/inflightCount/pid/servingAt/startedAt | 字段相同，未加密，generation=7 | 一致 |
| 3 | Box SSE GET | `accept: text/event-stream`，Bearer token（cmt D:137187） | `Bearer synthetic-box-token-1` | 一致 |
| 4 | Box hello | localRoot/terminalsFolder/computerId/label/supervised/variant/capabilities{messagesOpGeneration:4}（D:137408–137425） | 字段与值一致；Linux 上没有 messagesOp:true | 一致 |
| 5 | 首个 ping | `{kind:'ping',supervised}`，心跳 CJe=10 s（D:97387） | 首个 ping 一致；10 s 周期见“未验证” | 一致 |
| 6 | welcome → providerId | 后续 POST 携带 providerId | `synthetic-provider` | 一致 |
| 7 | Box exec，ask 模式且带匹配的 approvalId | 走 handleExecRequest，并调用 isLocalUseBlocked({approvalId, authorization:none, describes:fUe})（D:136309–136332，Nwr D:137564）；放行后执行；拒绝时发 x9 control throw（D:136410） | **修复前**：file-error ASK_MSG（忽略 approval）。**修复后**：client start/stdout/exit + streamClose | 有差异 → 已修（F1） |
| 8 | Box download | `{kind:'file',bytesBase64}` | 一致 | 一致 |
| 9 | Box upload | `{kind:'file'}`，文件落盘 | 一致 | 一致 |
| 10 | Box messages-op | Linux 上无 sidecar → messages-error `sidecar_missing`（D:84677） | 一致 | 一致 |
| 11 | Box 失败退避 | 1 s 起翻倍、上限 10 s（Twr/vwr，D:137179–137180） | 503 出现在 +1.10 s、+3.10 s、+7.10 s，间隔 2 s、4 s | 一致 |
| 12 | 连续 3 次失败后交换连接 | Cwr=3（D:137183），触发 onConnectionStale → POST `/sand-box/local-exec-connection` `{credential}` | 第 3 次失败后立即发出一次 exchange；body 为 `{credential}`；带 mb 头 | 一致 |
| 13 | 交换回复的落盘与重连 | 回复写入加密的 connection.json；用新 baseUrl/token 重连；networkToken → `x-anyrun-network-token` | 已加密；box2 收到 `Bearer …-2` 和 net token | 一致 |
| 14 | UC Watch hello | label/localRoot/terminalsFolder/standing/supervised/variant/SA/capabilities；32 字节 presence | standing 为 ask，SA=false，capabilities 含 aiToolSetup/mobileLocalTools[] | 一致 |
| 15 | UC 服务时 Box 空闲 | UC connected 后 Box idle（D:179262，onLoopEvent D:179404–179412） | box2 断开，不再重拨 | 一致 |
| 16 | connected/notify/heartbeat → poll | connected 与 notify 触发 poll；heartbeat 只在 pendingRequestCount>0 时触发（D:178396–178404） | heartbeat(0) 不触发 poll，heartbeat(5) 触发 | 一致 |
| 17 | ACK | 下一次 Poll 带上 ackIds | 5 个都已 ACK | 一致 |
| 18 | UC exec（本地 approval） | AUe/Qce 放行 → 执行 | `UC_LOCAL_APPROVED` + streamClose | 一致 |
| 19 | UC download/upload（带 approval） | file{data,last}/file{last} | 一致，文件已落盘 | 一致 |
| 20 | UC messagesOp | messagesError `sidecar_missing` | 一致 | 一致 |
| 21 | UC localTool，macOS 工具 | `{status:'failed',error:'This computer has no "…" tool.'}`（D:134962） | 文本一致 | 一致 |
| 22 | 静默续订 | 15 s 无事件 → renew，加 0–2 s 抖动后重新 Watch（t9r/r9r D:177837–177838） | 最后一个事件后 15.0 s 发生 watch-end，+1.48 s 重新 Watch；日志 `renewed … after 15 s of silence` | 一致 |
| 23 | unauthorized | Poll 401 → rejectCredential → 发布 rejectedAccountScopes → channelRetry 10 s 后重新 Watch（D:178240/178284） | 已发布 scope，10.02 s 后重新 Watch，connected 后清除 scope | 一致 |
| 24 | SA 翻转 | 旧 provider close，**不** withdraw；新建 uee + v_（D:179340–179366）；standing "" 时 authorizedByStanding 可执行 | withdraw=0；新 hello 为 SA=true、standing ""；`SA_STANDING` 执行成功 | 一致 |
| 25 | SIGTERM 退出 | IDe 设 withdrawPresence:true（D:79749）→ close 先 abort watch，再用活动 presence 调 Withdraw（D:178005–178030）→ 清除 discovery，退出码 0 | watch-end 后 1 ms 内 withdraw，presence 匹配；discovery 已删除；exit 0 | 一致 |
| 26 | localRoot 默认值 | wft：trim(SAND_LOCAL_EXEC_ROOT) → trim(SAND_AGENT_PROJECT_DIR) → homedir()，原值直接传入（D:132542–132545，D:187320）；App 两个变量都不设（静态 grep main-core.cjs 无匹配） | **修复前**：`path.resolve(ROOT \|\| process.cwd())`，真实 App 启动时服务的是继承来的 cwd。**修复后**：与 wft 一致 | 有差异 → 已修（F2） |
| 27 | 内部 exec 消息 id | 每个 v_ 自己的 `nextExecId=1`，`o.id=a`（D:135935、136332–136333）；Box 一个 v_（D:137251），每个 UC provider 新建 v_（D:179358），SA 重建也新建 | t165 观测：进程级全局计数（Box=1、UC=2、SA=3）。**t166 修复后**（final 运行）：Box 服务端 id 41 → 本地 1；UC 首个 exec=1；cancel 测试的第二个 UC exec=2；SA 重建后=1 | 差异→已修（F3） |
| 28 | mb 头：连接交换 | O9r `{"content-type", ...mb(client)}`（D:179124）；mb 名称/顺序（D:79034–79044）；合成 env 下静态推得：tse→sand-dev（79045）、ese→dev（78973）、VPe→`0.79.3-dev`（78996/78970）、BAt→`sand-desktop`（79007）、$At linux（79021） | 线上 rawHeaders 顺序：content-type、user-agent、x-cursor-client-type、x-cursor-client-version、x-sand-box-namespace、x-cursor-client-os、x-cursor-client-source；值逐字节相同 | 一致 |
| 29 | mb 头：UC | E9r 拦截器在每个请求上执行 `header.set(mb)`（D:177883）；connect-node 1.6.1 的 d8r 使用 `new Headers`（D:175951），名称按排序迭代；无 authorization | Watch/Poll/Submit/Withdraw 共 8 个请求：mb 值逐字节相同、名称已排序、无 authorization；本仓库 connect / connect-node 同为 1.6.1 | 一致 |
| 30 | Box 头（cmt） | `{accept或content-type, ...connection.headers, authorization}`（D:137186、137306、137398），不带 mb | GET：accept → (x-anyrun-network-token) → authorization；POST：content-type → (token) → authorization；没有任何 mb 头（`accept: */*` 和 `user-agent: node` 是 undici 默认值） | 一致 |
| 31 | Poll 401 窗口内 Box 重拨 | onLoopEvent unauthorized → `x.add(scope)`，并 `Te.wakeFromReconnectBackoff()`（D:179408）；X() 为假，Box 可拨号；connected 后 `Te.redial()` → Box 空闲 | 窗口内 box2 有新的 GET；connected 后回到空闲 | 一致 |
| 32 | 取消运行中的 exec | handleCancel → execManager `abort{id: execId}` → cancel（D:136353–136364） | 21 ms 内收到 exit `{aborted:true, abortReason:USER_ABORT, code:4294967295}` + streamClose；帧形状与既有 lab oracle 的 cancel 一致（scenario-matrix §shell cancel） | 一致 |
| 33 | retireApproval | 照常 ACK，持久化退役记录，不发任何回复帧（D:178509–178555，wUe D:81351）；之后同一 approval 不再授权 | 无回复帧；`local-tool-retirements.json` 内容为 `{"retiredIds":["ap-uc-exec"]}`；再用同一 approval 执行 → control throw ASK | 一致 |
| 34 | Watch 401 + 凭据续期 | Watch 返回 Unauthenticated → s 为 "unauthorized"（D:178256）→ 清空 channel，sleep channelRetry 10 s（D:178280–178284）→ resolveChannel 重新读取凭据 → 用新凭据 Watch；scope 与 SA 不变时 Ve 执行 `continue`（D:179352），不 withdraw、不重建 | 旧凭据 Watch 被拒；发布了 rejectedAccountScopes；窗口内 Box 重拨；**10.007 s** 后用新凭据 Watch；中间没有其他 Watch；withdraw=0 | 一致 |
| 35 | backendReturn 提前唤醒 | Unavailable 时 noteFailure 判为后端宕机（w8r D:176402）；reconnectBackoff 按 1/2/4/8 s（Q8r D:177834）；standing tick 每 2 s（Rre D:78811）读取 marker（He D:179436）→ noteBackendReturn → 在 random·2 s 内唤醒（g8r D:176381、176445） | 前 3 次故障间隔 1004/2005/4006 ms；第 4 次故障后本应睡 8 s，实际写入 marker 后 **2.56 s** 就重新 Watch（距第 4 次故障 2.87 s） | 一致 |
| 36 | network-change 续订 | standing tick Rre 2 s（D:78811）比较 D9r 指纹（D:179161–179170，忽略 internal/link-local）→ noteNetworkChange（D:178295–178313）abort Watch，原因 network-change（D:178361）→ renew：新 E9r client，不 sleep（D:178270–178275）；30 s 冷却 n9r（D:177839/177950），冷却期内的变化 deferred，到期再执行 | 真实 OS 变化（`unshare -rn` 里加 veth 10.77.0.1/24）：**1.49 s** 内重新 Watch；3 s 后第二次变化被合并，**30.0 s**（29 999 ms）后才执行；3 个 Watch 来自 3 个不同源端口（新连接）；日志 2 行 `renewed on a new connection after a network change` | 一致 |
| 37 | Box 10 s 心跳周期 | 立即 ping，此后每次 tick 完成后 10 s（hc/yre D:78435–78530，CJe D:97387）；ping POST 不 await（heartbeat.start D:137435） | 首个 ping 在 hello 后 2 ms；ping POST 人为延迟 3 s，间隔仍为 10 002 / 10 002 / 10 002 ms | 一致 |
| 38 | discoverAiTool（UC + Box） | VJe（D:97585–97840）：bp 脱敏（D:97102）、上限 pHt 256 KiB/FJe 500/mHt 24/hHt 200/$pe 40/XP 160，schema cHt…fHt（D:97544–97570），未找到 Fpe（D:97081） | 合成 HOME（假 ~/.claude、~/.codex，含 sk-/ghp_/Bearer/token/邮箱/URL/路径/超长串/畸形行）：UC claude/codex 字节与按 D: 手推结果完全相同（7 会话/16 条、2 会话/7 条），last 标志正确；Box claude 相同、codex 为 NOT_FOUND；非法 source → UC fileError z2 / Box 丢弃（`dropping unparseable request frame`） | 一致 |
| 39 | putFileToUrl / getFileFromUrl | UC：v9r（D:178862–178905）返回 undefined → w9r（D:178785–178793）发 x9 control throw z2；Box：MJe 未知 kind 经 Upe 静默忽略（D:97455） | UC 两种都回 `{throw:{error:z2}}` 且被 ACK；Box 无任何回复帧 | 一致 |
| 40 | mb 头 e2e，非 dev 环境 | eke/jAt/ese/VPe/BAt/FAt/mb（D:78962–79157）；Box cmt 不带 mb（D:137186） | packaged（0.79.3/prod/sand）、lab（0.79.3-lab/lab/sand-lab）、owner 命名空间（` dev ` → 0.79.3-dev/dev/sand-dev）、isolated（SAND_ISOLATED_DEPLOYMENT=1 → 0.79.3-dev/prod/sand）、版本后缀（` 1.2.3-rc.1 ` → 1.2.3）：交换 = [content-type, …mb]，UC 名称排序，Box 无 mb，hello variant 一致 | 一致 |
| 41 | Electron 内置 Node 的 undici 默认头 | App 二进制静态字符串：Electron/42.11.16、Node v24.19.0、Chrome/148.0.7778.280 | npm 公开 electron@42.11.16（Node 24.19.0）以 `ELECTRON_RUN_AS_NODE=1` 运行我们的 dist：exchange/Box GET/Box POST/UC Watch 头与本机 Node 24.22.1 完全相同 | 一致 |
| 42 | `utilityProcess.fork` 主启动路径（M$e） | `fork(entry,{env,stdio:"pipe",serviceName:"sand-local-exec-daemon"})`，handoff 经 parentPort（oqr D:187211） | 公开 electron@42.11.16 在 xvfb-run 下 `utilityProcess.fork` 我们的 dist，postMessage 交接：正常服务；四类请求头与 Node 相同 | 一致 |
| 43 | SAND_NODE_PROXY_ENV（系统代理模式） | sqr（D:187195–187207）在模块加载时调用 nke（D:79217–79232）：删除变量，`http.setGlobalProxyFromEnv`；VAt 指纹（sha256 前 16 hex）写入 discovery（D:179216）；协调器传 `[Rs]: nodeProxyEnv.raw`（coordinator 66932），按指纹 adopt/replace（Pce 66625–66633） | **修复前**：完全没有 → 开代理时 daemon 直连，discovery 无指纹，协调器认为指纹不匹配。**修复后**：假代理观测到 exchange（CONNECT）、Box GET/POST 经代理；UC 走自带 Agent 不经代理（与 E9r 相同）；discovery `proxyFingerprint` = 期望值 | 差异→已修（F4） |
| 44 | sqr 的 env 清理 | 删除 SAND_LOCAL_EXEC_INHERITED_FDS（并用 wDe 关闭 /proc 链接仍匹配的 fd，D:79641–79658；App 的 Kre 在 L$e 路径设置它）、SAND_LOCAL_EXEC_FILE_KEY、NODE_USE_SYSTEM_CA（R$e 设为 "1"） | **修复前**：三项都留在 env，传给所有 exec 子进程（用户命令里能看到 NODE_USE_SYSTEM_CA=1），继承 fd 不关闭。**修复后**：按 sqr 顺序删除并关闭（单测） | 差异→已修（F5） |
| 45 | Box SSE GET 的实现 | 全局 fetch（D:137396–137402）：`fetch(baseUrl+RJe,{headers:cmt({accept:"text/event-stream"},p),signal})`，默认 redirect follow；`!m.ok \|\| !Owr(m)` → j5e `local-exec requests stream failed: ${status}`（Owr D:137205）；`o.body.getReader()` + `TextDecoder` `{stream:true}` 分帧（D:137441–137471） | **t168 时**：用 `http.request`，缺 undici 默认头、只认 200、不跟随重定向、经代理时 http 目标用绝对 URI。**t169 修复后**：改为全局 fetch，线上头为 connection、accept、(token)、authorization、accept-language: *、sec-fetch-mode: cors、user-agent: node、accept-encoding（与 Box POST 同一 undici 栈）；203 视为连接成功；307 被跟随；503 → 失败并 1 s 后重试；跨 chunk 的多字节 UTF-8 正确；经 F4 代理时 Box GET 也走 CONNECT | 差异→已修（F6） |
| 46 | isolated 部署的出站拒绝 | daemon 中 QPe（D:79103–79130）构造 `{backendUrl, refuses}`，但整个 daemon bundle 里 `refuses` 只有定义（D:79125），没有任何调用；`isolated deployment refused` 文本只在 App main-core 的 Ij/session 守卫里出现 | 我们只移植了 QPe 的校验与 backendUrl（mb、exchange 已 e2e 验证），不做出站拒绝——与 daemon 原版相同（静态核实） | 一致 |
| 47 | 无 IPC 时的 env 文件密钥 | sqr 读取 SAND_LOCAL_EXEC_FILE_KEY（D:187198、187204）；iqr 在无 parentPort 且 `process.channel == null` 时返回 `{fileKeyBase64: Ly.preIpcFileKeyBase64}`，**不带 computerId**（D:187256–187257）→ cqr 抛 YAe `missing its machine id`（D:187302–187303）→ `fatal: Error`（xt D:78680，exit 1） | 我们无通道时直接 `fatal: Error` exit 1；env 变量已由 F5 删除。可观测行为相同（静态核实）；0.79.3 App 也从不设置该变量 | 一致 |
| 48 | handoff 消息的容错 | Uae（D:79679–79687）：type 不对的消息被忽略、继续等待；computerId 经 Lae trim（≤127）；key 非 32 字节时 key=null 但仍以 null key 服务（明文读文件、省略 filesKeyId，lgt D:179177）；IPC disconnect/5 s 超时 → key=null（iqr D:187232–187283） | **修复前**：第一条消息不合法就 fatal；computerId 不 trim；坏 key 直接 fatal。**修复后**（t171）：与 iqr/Uae/oqr 一致，测试 `test/t171-remaining-diffs.test.cjs` | 有差异 → 已修（F7） |

注：x9 会经过 `oa(...).toJson()`，所以线上 throw 帧是 `{throw:{error}}`，`id:0` 被省略。我们的 Box 输出与之一致，见 t165-dropin-fixes 测试。

## Linux 上不可达
- messages sidecar：真实的 iMessage 读写和发送。Linux 上只有 `sidecar_missing`，已验证。
- macOS 本地工具，例如 mac_read_obsidian 和 computer-use 截图。只验证了 "no tool" 分支。

## 未验证（e2e）
- 无。原先列出的项都已观测或静态核实，并入上表。


## localRoot（F2）对 0.79.3 的核实（t166）
- 来源：`/workspace/grokbot-linux-0.79.3/extracted/opt/Grok Bot/resources/app.asar`（package.json version 0.79.3）。`dist/electron-main/main-core.cjs` 的 sha256 为 910cc6bf…e34d，与 `/tmp/gbproto-0793`、`/workspace/grokbot-sync-evidence-0793` 中的副本一致。只做了静态读取，抽取的文件在 `/tmp/exec-t166-evidence/app-0793/`。
- 在整个 asar 中，`SAND_LOCAL_EXEC_ROOT` 和 `SAND_AGENT_PROJECT_DIR` 只出现在 `dist/local-exec-daemon/main.cjs` 的 wft 里（各 1 次）。electron-main 的四个文件（main / main-app / main-core / proto）都没有出现。
- 启动器（main-core.cjs）：
  - R$e = `{...process.env, ...e.env, SAND_LOCAL_EXEC_GENERATION, NODE_USE_SYSTEM_CA:"1"}`，去掉 `ELECTRON_RUN_AS_NODE`；
  - M$e 为 `e.fork(entryPath, {env, stdio:"pipe", serviceName:"sand-local-exec-daemon"})`；
  - L$e 为 `spawn(process.execPath, entryArgv, {detached:true, stdio:["ignore",log,log,"ipc"], env})`；
  - 两处都**不传 cwd**，即继承父进程 cwd。
- 结论：0.79.3 的 App 不设置这两个变量（除非用户的进程环境里本来就有），所以原版 localRoot 等于 `os.homedir()`。F2 成立。
- 注：`/workspace/grokbot-node-analysis-0793/main.cjs` 是 daemon bundle（不含 `require("electron")`），不是 App 主进程。
## 修复清单（F1–F7 及之后）
- **F1** `src/box/provider.ts`：Box exec 改为先 `execRefusal({...boxRefusalInput(), approvalId: ev.approvalId, describes: describeExec(serverMessage, root/terminals)})`。
  被拒时发 control throw（x9）；放行后以 `permission:"always"` 执行，不再做第二道闸。
  依据 D:136309–136332、D:136410、D:137564。
- **F2** `src/util.ts` 的 `localRootFromEnv` 改为 wft 语义；`src/index.ts` 不再 `path.resolve`。依据 D:132542–132545、D:187320。
- 测试：`test/t165-dropin-fixes.test.cjs`，共 4 项。
- **F4**（t168）`src/state/node-proxy.ts`（新）+ `src/index.ts` + `src/state/discovery.ts`：模块加载时按 nke 处理 SAND_NODE_PROXY_ENV，discovery 增加 proxyFingerprint（generation 之后、rejectedAccountScopes 之前）。依据 D:79197–79232、D:179216、D:187195–187207。
- **F5**（t168）`src/bootstrap/boot-env.ts`（新）+ `src/index.ts`：sqr 的 env 清理与继承 fd 关闭。依据 D:78805–78806、D:79641–79658、D:187194–187210。
- 测试：`test/t168-node-proxy.test.cjs`，共 5 项；e2e 见 dropin-extra 的 SAND_NODE_PROXY_ENV 用例。
- **F6**（t169）`src/box/provider.ts`：Box SSE GET 由 `http.request` 改为全局 `fetch`，状态判定、重定向、默认头、TextDecoder 分帧与 streamRequests 一致；其余不变。依据 D:137186、137205、137396–137402、137441–137471。测试 `test/t169-box-sse-fetch.test.cjs`，共 5 项。
- **F7**（t171）`src/bootstrap/handoff.ts` + `src/bootstrap/boot-env.ts` + `src/index.ts`：handoff 改为 iqr/Uae/oqr 语义（忽略非法消息、trim computerId、坏 key→null key、IPC disconnect/超时→null key、finally 断开 IPC）。依据 D:79662–79687、D:187212–187303。其余修复见 [remaining-diffs.md](remaining-diffs.md)。
- **t175** `src/bootstrap/crash-guard.ts`（新）、`src/index.ts`、`src/state/discovery.ts`、`src/settings.ts`、`src/exec/handlers.ts`、`src/box/provider.ts`：见 [port-coverage.md](port-coverage.md) §4。测试 `test/t175-port-coverage.test.cjs`，共 7 项。
- **t176** `src/exec/denylist.ts`、`sandbox.ts`、`background-shell.ts` + `handlers.ts` / `settings.ts`：后台 shell、denylist、requestedSandboxPolicy、settings 读错误 rethrow。测试 `test/t176-background-denylist-sandbox.test.cjs`，共 6 项。详见 [port-coverage.md](port-coverage.md) §6。
