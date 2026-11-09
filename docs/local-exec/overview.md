# local-exec-daemon 总览

面向读者：需要了解「这个进程在 Grok Bot App 里干什么、我们仓库里移植到哪一步」的人。
实现代码：`packages/local-exec-daemon/`。目标对照版本：App **0.79.3** 原版 daemon bundle（下文 **D:** = `/workspace/grokbot-node-analysis-0793/daemon.formatted.cjs` 行号）。
本文是**证据导向**的职责说明，不是功能宣传；细节与验收矩阵见文末姊妹文档。

---

## 1. 在 Grok Bot App 中的角色

`local-exec-daemon` 是 App 托管的**本地执行侧进程**（utilityProcess / Node 子进程），不是 GUI，也不是云端后端。

典型生命周期（与原版 `cqr`→`lgt` 一致，D:187180+ / D:179109+）：

1. **App 拉起进程**，注入环境（如 `SAND_DATA_ROOT`、`SAND_LOCAL_EXEC_GENERATION`、`NODE_USE_SYSTEM_CA` 等；见 dropin-acceptance 对 main-core 的静态对照）。
2. **IPC / parentPort 交接**（`sand-local-exec-file-key`）：父进程下发密封文件用的 key 与 `computerId`。无 `computerId` 视为 fatal；坏 key 仍可明文服务（D:187302–187303）。
3. Daemon **安装 crash guard**、清洗启动 env、解析 `localRoot`，然后进入服务体 `lgt`。
4. 向数据目录写入 **discovery** 记录（pid / servingAt / generation / inflight / 可选 proxyFingerprint、rejectedAccountScopes），供 App 判断「本机谁在服务」。
5. 按连接文件同时或交替维护两条**出站通道**：
   - **Box**：SSE `GET …/local-exec/requests` + `POST …/local-exec/responses`（JSON 帧）。
   - **User Computer（UC）**：Connect `Watch` / `Poll` / `Submit` / `Withdraw`（protobuf）。
6. UC 一旦 `connected`，Box 进入空闲（不再重拨）；凭据/网络/静默续订等事件可再唤醒或切换。
7. **Ownership**：定期对照 discovery / supervisor / update-lease；被接任或失去桌面所有权则有序关停（withdraw presence、清自己的 discovery、exit 0）。

App 侧负责：账号 UI、选机、拉起/监督进程、读写部分用户设置与审批文件的**产品语义**。  
Daemon 侧负责：在本机执行工具、把结果帧送回 Box/UC、维持 presence 与 discovery 新鲜度。  
云端后端负责：UC/Box 的请求调度与鉴权；daemon 不替代后端。

---

## 2. 职责边界

| 主体 | 做什么 | 不做什么 |
|---|---|---|
| **本 daemon** | 交接后常驻；发布/清理 discovery；读 settings / approvals / grants；跑 exec（shell/read/ls/后台 shell 等）；经 Box 或 UC 收请求、回帧；连接交换与续订；关停时 withdraw + 清**自己的** discovery | 不画 UI；不签发账号 token；不替 App 做「是否安装/升级自己」的产品决策 |
| **Grok Bot App** | 启动 utilityProcess、发 handoff、监督 freshness、展示会话与审批 UI | 不在渲染进程里直接跑 shell；本地执行语义由 daemon 拥有 |
| **后端（UC/Box）** | 下发工具请求、收结果、鉴权 SA/standing | 不访问用户本机文件系统（经 daemon 中介） |

权限默认来自本机 `settings.json`（Never / Ask / Always 等）与 `local-tool-approvals.json` 等 durable 文件；**serverAuthoritative** 通道上以服务端授权为准（见 UC approvals 移植）。Daemon **不提供**自批准/写审批 API。

---

## 3. Linux 上可达且线上可观测的能力（我们的移植）

下列能力在 Linux 合成/门控验收中有对照（见 `dropin-acceptance.md`），并在 `packages/local-exec-daemon/src/` 有对应实现。括号内为关键入口或 D: 锚点。

### 进程与状态
- **Crash guard**：`uncaughtException` / `unhandledRejection` 记日志后进程保持存活（D:pTe/V7t 78686–78712；`src/bootstrap/crash-guard.ts`）。
- **Handoff**：Node IPC 与 Electron `parentPort`（`src/bootstrap/handoff.ts`）。
- **Discovery / ownership / lease**：发布、被接任容忍、关停只删本 pid 记录（PLe；`src/state/discovery.ts`、`lease.ts`）。
- **Settings 热读**：完整 schema；不可读 → ask 默认；durable `damaged` / `unsupported` 日志（II/BDe；`src/settings.ts`）。
- **原子写**：默认路径 `cp`（无 noFollow；`src/state/fs-write.ts`）。读损坏路径恒 `copy=none`（daemon 不走 keepDamaged 写链，见 port-coverage §10）。

### 执行器（Tft 注册：shellStream / backgroundShell / read / ls）
- **shellStream**：超时默认 30 s；`timeoutBehavior=BACKGROUND` 软超时转后台 + `terminals/{id}.txt`；`hardTimeout`；取消/abort 帧（`src/exec/handlers.ts`、`background-shell.ts`）。
- **管理员命令 denylist** + **requestedSandboxPolicy**（Linux 无 helper → `sandboxUnsupported`；tree-sitter 解析，`src/exec/denylist.ts`、`sandbox.ts`）。
- **read / ls**：路径与 symlink 守卫；ls 为浅 `readdir` 填同一 schema（与官方 ripgrep 树有意差异，见包内 README）。
- **输出通道 Ki + 心跳**：UC/Box exec 结果进入无界 outbox（`src/exec/output-channel.ts`）。
- **未注册消息**：通用 `No handler found…`；`computerUseArgs` / `recordScreenArgs` 固定拒绝文案（jHt，D:98041–98046）。

### Box 通道（`src/box/provider.ts`）
- SSE 请求流、hello / ping、welcome→providerId、exec / download / upload。
- 失败退避、连续失败后 connection exchange、与 UC 互斥空闲。
- Linux 上 **messages-op** → `sidecar_missing`（与原版一致）。

### UC 通道（`src/uc/provider.ts` 等）
- Watch hello（label/localRoot/terminals/standing/capabilities…）、Poll/Submit/Withdraw。
- 静默续订、401 unauthorized → rejectedAccountScopes + channelRetry、network-change、backendReturn 唤醒。
- **outage ledger**：stdout JSON `watch_outage`（App 可解析；`src/uc/outage-ledger.ts`）。
- exec / upload / download（含 approval 链）、retireApproval、多 accountScope provider、SA 翻转重建。
- **discover-ai-tool**、standing grants 读取、Obsidian 等跨平台 local-tool 子集（darwin 专用工具走「无此工具」失败文案）。

### 其它
- 密封凭据、连接文件加密封、mb/客户端头、启动 env/fd 清理、`SAND_NODE_PROXY_ENV` 等启动语义。
- 协议：冻结 `.proto` → `src/generated/`，Connect + protobuf-es；**不手写**业务帧 schema。

更细的逐步对照表见 [dropin-acceptance.md](./dropin-acceptance.md)；函数级覆盖见 [port-coverage.md](./port-coverage.md)。

---

## 4. 有意不移植（及指针）

| 类别 | 说明 | 文档 |
|---|---|---|
| **Sentry 出站崩溃上报** | T7t 等；需 `@sentry/node` + 脱敏；仍标 MISSING 大项 | port-coverage §6、remaining-diffs #20 |
| **macOS sidecar / Messages** | `.app` 查找；Linux → `sidecar_missing` | remaining-diffs #2、dropin-acceptance「Linux 不可达」 |
| **darwin 本地工具 / computer-use / 截图** | 平台门控；Linux 仅「无工具」或未注册拒绝 | port-coverage §3、remaining-diffs #3 |
| **后台三组件** | `forceBackgroundByToolCallId`、outputNotification 观察器、backgroundWorkRegistry 完成队列：原版 Tft 不传 registry / 未注册 / 无调用点 → 不可达且无可观测效果 | port-coverage §9、t181 |
| **settings keepDamaged / noFollow 写链** | daemon 对 settings 只用 getter；读损坏 `copyPath:null` | port-coverage §10 |
| **`invariant_violation` 事件** | App 只解析 `watch_outage` | port-coverage §7 |
| **死常量 ein/tin/…、深链 routeString 等** | 无 Linux 线上帧 / App 日志缺口 | port-coverage §10 |

这些不是「忘了做」，而是静态可达性 + 可观测性核验后的明确边界。

---

## 5. 与「替换 / drop-in」的关系

- **包名与 bin 名**保持 `local-exec-daemon`（private workspace：`packages/local-exec-daemon`），不加 `-compat` 后缀。
- **目标**是行为上兼容 App 0.79.3 所托管的官方 daemon（IPC 形状、discovery、Box/UC 帧、关停语义等），以便在受控环境验证「能否承担同一角色」。
- **不声称**无条件、开箱即用的正式安装替换：
  - 验收以**合成后端 + 合成凭据**为主；门控 harness 设 `DROPIN_ACCEPTANCE=1`。
  - 测试与证据流水线使用 **`UC_SKIP_OFFICIAL=1`**，**禁止**执行官方 main.cjs / App 内嵌 electron / worker。
  - Electron 烟测可用公开 npm 的 Electron 二进制；**不等于**官方 App 所嵌 42.x 的验收。
  - 已知有意差异（如 ls 非 ripgrep 树、Sentry 未接）见包内 README 与 remaining-diffs。
- 目录内 [README.md](./README.md) 是兼容边界短声明；本文是职责与能力总览。

---

## 6. 姊妹文档（按需深入）

| 文档 | 内容 |
|---|---|
| [README.md](./README.md) | 兼容边界一页纸；指向包内 README / headless |
| [dropin-acceptance.md](./dropin-acceptance.md) | 替换验收矩阵与门控 harness 观测 |
| [port-coverage.md](./port-coverage.md) | 函数级覆盖审计、MISSING/有意不移植、§9–§10 |
| [remaining-diffs.md](./remaining-diffs.md) | 剩余差异逐项根因与状态 |
| [close-stream-evidence.md](./close-stream-evidence.md) | Ki 通道、关停/取消顺序、附件源边界 |
| [scenario-matrix.md](./scenario-matrix.md) | 场景与 App 启动静态对照 |
| [ownership-oracle.md](./ownership-oracle.md) | ownership 对照与 fixture 说明 |
| `*-evidence.md` | 单点证据（Box hello/upload、UC download、connection-exchange 等） |

包内文档：`packages/local-exec-daemon/README.md`（命令与状态表）、`REVIEW-FIXES.md`、`INTEGRATION.md`。

---

## 7. 源码地图（速查）

```
packages/local-exec-daemon/src/
  index.ts                 入口：handoff → discovery → Box/UC 生命周期
  bootstrap/               crash-guard、handoff、boot-env
  settings.ts              settings schema + durable 日志
  state/                   discovery、connection、lease、fs-write、standing-signals…
  exec/                    handlers、shell-session、background-shell、denylist、sandbox、codec、Ki
  box/                     Box SSE provider、messages-op（Linux sidecar_missing）
  uc/                      Watch/Poll/Submit、approvals、outage-ledger、ai-tool、local-tools…
  generated/               冻结 proto 生成代码
```

构建：`npm run build`（包内）。测试：`npm test`；门控替换集：`DROPIN_ACCEPTANCE=1` + `UC_SKIP_OFFICIAL=1`。
