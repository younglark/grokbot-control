# 交接说明

写于 2026-11-10，对应 `main` 上 25e89c8 之后的文档整理。这里只写当前状态和接手需要知道的事；过程记录在 [history/](history/README.md)。

## 1. 一句话现状

- **控制面**（`grokbot-control`）：已实现。当前通过 GitHub tag `npm-v0.3.0` 分发（`npx -y --package=github:younglark/grokbot-control#npm-v0.3.0 gbc`），由推送 `v0.3.0` 后的 Actions 生成该 tag，不再向 npmjs 发布。已推送的 `v0.2.0` / `v0.2.1` 不要改写；`v0.2.0` 的发版任务因测试挂起被取消，没有生成 `npm-v0.2.0`。npmjs 上的 `grokbot-control@0.1.3` 已停止更新。离线测试覆盖完整；live 验证过 CLI 登录、2026-11-11 的 bot 模式轮询收束、三个只读 RPC，以及一次隔离的同步验收。选中团队绑定与 OAuth 刷新仍未 live 验证。详见 packages/grokbot-control/CHANGELOG.md 与 [development.md](development.md) 的发版一节。
- **local-exec-daemon**：按 App 0.79.3 原版 daemon 逐函数移植。Linux 上可达、可观测的路径已对齐，有 D: 行号证据和测试；通过了合成后端的门控验收（48 步矩阵：41 步一致、7 步发现差异已修复；另有 2 项 Linux 不可达）。**完整替换验收没有做**，不能说是无条件 drop-in。
- **无头注册 / Docker**：只有设计边界，没有代码。

## 2. 已完成

| 领域 | 内容 | 入口文档 |
|---|---|---|
| 协议 | 0.79.3 schema 冻结（`schema-0.79.3` + 增补 Exec 闭包的 `schema-0.79.3-daemon-exec`），一个生成器同时产出 control ESM 和 daemon TS | [protocol/](protocol/README.md) |
| 控制面 | bot / message / session / sidebar / progress / computer / auth / sync，CLI 与 MCP 语义一致；原生跨进程刷新锁 | [control-plane/](control-plane/README.md) |
| daemon 启动 | IPC / Electron parentPort 交接、crash guard、启动 env 与 fd 清理、代理 env、discovery、ownership | [local-exec/overview.md](local-exec/overview.md) |
| daemon 通道 | Box（SSE + POST）、UC（Watch/Poll/Submit/Withdraw）、连接交换、续订、unauthorized、network-change、backendReturn、outage ledger、多账号 | 同上 |
| daemon 执行器 | 原版 Tft 只注册 4 个：shellStream、backgroundShell、read、ls；denylist（tree-sitter）、sandboxPolicy、spawnWorkload（Md/CE/cgroup/FUSE/oom） | [local-exec/remaining-diffs.md](local-exec/remaining-diffs.md) |
| daemon 非 exec | upload / download（UC 附加流、Box 整文件）、discover-ai-tool、messages-op（Linux → `sidecar_missing`）、local-tool（含 Obsidian）、审批与 standing grants | [local-exec/evidence/](local-exec/README.md#单点证据) |
| 覆盖审计 | 1955 个可达单元逐一归类，「应移植」= 0、「不清楚」= 0 | [local-exec/port-coverage.md](local-exec/port-coverage.md) |

## 3. 未完成

| 项 | 说明 |
|---|---|
| **daemon 完整替换验收** | 只在合成后端 + 合成凭据下验收过；没有接真实后端，没有在真实 App（内嵌 Electron 42.11.16）里替换官方 daemon。要做必须先拿到用户对环境和账号的明确授权 |
| **队列 / 心跳整体验收** | 各机制单独对过官方 oracle（重试/丢帧/公平性/keepalive/心跳），但整体在负载下的分布还有差异（见 §4） |
| **Sentry 崩溃上报** | 原版 T7t（D:187161）。默认**不移植**（需新增 `@sentry/node` 和脱敏移植）；计划见 [port-coverage.md](local-exec/port-coverage.md) §6 |
| **其它未移植的小项** | tracing span `Xi`（无线上效果）；`Ko` 按信号杀进程树（shell/后台 shell 仍用自己的 abort/kill 路径） |
| **无头注册 / Docker** | 下一阶段。需要先查清注册/凭据流程的证据，并单独获得授权 |
| **侧边栏「分组」语义** | 暂搁置。目前按 SidebarSections 实现；Room / TeamGroup 未做 |
| **控制面 live** | 所有写 RPC、OAuth 刷新、命名 session、附件上传等都没有 live 验证，见 [control-plane/implementation-status.md](control-plane/implementation-status.md) |
| 旧的大范围安全复核 | 已暂停，**不要恢复** |

## 4. 已知风险与有意保留的差异

- **两处有意安全偏离（与「和原版一致」的要求有冲突，待用户决定）**：shell 的 cwd 含换行时，原版会把第二行当命令执行，我们把 cwd 当长度前缀数据，不进脚本；shell 状态快照我们要求完整 START/END 才提交，原版缺 grep 时保留旧状态。见 [scenario-matrix.md](local-exec/scenario-matrix.md)。
- **与原版相同的固有问题**（照原样保留，不要自行「修复」）：回复队列在后端卡住时内存无上限；ownership 发布存在非 CAS 竞态窗口（[evidence/ownership-oracle.md](local-exec/evidence/ownership-oracle.md)）。
- **时序类测试可能抖动**：门控 harness 要跑真实的 15 s / 10 s 计时器（约 75 s）；负载下 hb-hold 的 keepalive 分布和官方不同；rotation 有过 1/15 次无法解释的提前。`retry-expiry` oracle 已用固定随机数确定化。历史失败都记录在 [history/local-exec-review-rounds.md](history/local-exec-review-rounds.md)，没有被抹掉。
- **依赖告警**：`npm audit` 报 Zod 3.x 和 connect-node 的 undici/busboy 链（3 high / 1 moderate），修复要跨大版本，未升级。
- **原生依赖**：`tree-sitter@0.21.1`、`tree-sitter-bash@0.21.0` 需要 install 脚本（根 `package.json` 的 `allowScripts` 已批准）；`fs-native-extensions@1.5.3` 用预编译包。
- **证据不在仓库里**：D: 行号依赖开发机上的格式化文件，见下节。新机器上需要按 §6 重建。
- **历史事故**：t154 有两次全量测试没设 `UC_SKIP_OFFICIAL=1`，3 个官方 oracle 用例在隔离 lab 里跑了官方 main.cjs 共 6 次。这就是现在强制该变量的原因。

## 5. 工作约定（必须遵守）

1. **与原版 0.79.3 保持一致**。不发明更「安全」的策略；原版的怪癖也照搬。不可达的代码不移植，但要用 D: 行号证据写明「为什么不可达」。
2. **证据驱动**：每个行为都写 D:（daemon）或 App 文件 + 行号/锚点；结论写进对应文档，测试钉住。
3. **协议不手写**：只能从冻结 `.proto` 经 `@bufbuild/protobuf` + `@connectrpc/*` 生成。冻结目录不可修改，升级要新建版本目录。
4. **第三方依赖必须写进对应包的 `package.json`**，不能依赖 node_modules 里碰巧有的东西，也不能从 App 里拷贝 `.node` 或 js。
5. **不运行任何官方代码**：官方 main.cjs、messages-worker、App 内的 Electron 或任何 App 二进制都只做静态阅读。所有测试命令前 `export UC_SKIP_OFFICIAL=1`。Electron 只用公共 npm 的版本。
6. **只用合成数据**：合成凭据、配置、HOME、假对端。不连真实后端/账号，不读真实凭据和审批文件，不改真实安全设置。生产代码里不加测试钩子。
7. 「Box」在本项目指 local-exec 的 Box 通道，和 Box.com 无关。
8. 汇报要有证据、给准确的测试数字，不夸大；永远不说「无条件 drop-in」。
9. Git：用户明确说 commit/push 才提交推送；不 amend、不 rebase 已推送提交、不 reset、不 force-push、不 `--no-verify`。

## 6. 开发机上的外部材料（不入库）

| 路径 | 用途 |
|---|---|
| `/workspace/grokbot-linux-0.79.3/` | 官方 deb 解包（`app.asar` 在 `extracted/opt/Grok Bot/resources/`） |
| `/workspace/grokbot-node-analysis-0793/daemon.formatted.cjs` | **D: 行号的来源**。asar 内 `dist/local-exec-daemon/main.cjs`（sha256 `5c1424ed…36be`，Linux 与 macOS 0.79.3 相同）经 prettier 格式化，187 625 行，sha256 `ad69a772…684c` |
| `/workspace/grokbot-sync-evidence-0793/` | coordinator / renderer 的格式化副本（控制面同步证据） |
| `/workspace/grokbot-proto/` | 上游 `extract_proto.py`（@ 49fd8ce） |
| `/workspace/local-exec-offline-lab-0793/` | 隔离 oracle lab，**里面有官方 main.cjs**；只有显式授权时才可用，默认靠 `UC_SKIP_OFFICIAL=1` 跳过 |
| `/tmp/exec-t1xx*` | 各轮的临时证据，重启后可能丢失，文档里的结论不依赖它们 |

App 更新后如何重建这些材料，见 [protocol/update-runbook.md](protocol/update-runbook.md)。

## 7. 推荐的下一步

1. 先完整跑一遍 [development.md](development.md) 里的测试分层，确认本机环境（含 `rg`、`unshare`、可选 `xvfb-run`）。
2. 若官方 App 出了新版本：按 [update-runbook](protocol/update-runbook.md) 新建冻结目录，并对 daemon 做 sha256 比对；sha 变了就要按锚点重新核对 [remaining-diffs.md](local-exec/remaining-diffs.md) 和 [port-coverage.md](local-exec/port-coverage.md)。
3. 和用户确认 §4 两处安全偏离是否也要改成与原版一致。
4. 申请授权后做 daemon 的真实环境替换验收（受控机器、测试账号），先只读观察，再逐步放开。
5. 无头注册：先静态查清 App 的电脑注册/凭据下发流程，写证据文档，再设计宿主进程。
6. 发版改走「推送 `v*`，由 Actions 生成 `npm-v*`」之后，在 npmjs 包设置里撤销 GitHub Actions Trusted Publisher，避免旧绑定在误恢复 `publish.yml` 时重新发版。推 `v*` 前须确认 Actions 账单/消费限额已恢复，工作流能跑完。
