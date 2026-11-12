# `computer wake`：App「唤醒电脑」到 RPC 的静态证据（App 0.79.4）

对应 issue #5。结论先行：

- **控制面实现**：电脑为 hibernated 时发一次 `GrokBotService.EnsureSandBox`，请求为空（`{}`：`wake`、`supports_asleep_box` 都不设），不带任何额外请求头；之后用 `GetSandBoxRunState` 读回。
- **证据等级**：静态（S）。App 里所有 `ensureSandBox` 调用点、三种请求形状、park 头的取值都已在源码中确认；「空请求会唤醒」「不带 park 头时服务端不会让电脑继续睡」是根据 App 的调用方式和字段命名做的**推断**，**没有 live 验证**。没有执行任何官方代码，没有真的唤醒过电脑。
- 唤醒不依赖 App 的设备/策略头。App 唯一可能附带的是 `x-sand-box-park`，而且只在 App 的 feature gate 打开时才带；gate 关闭（`"off"`）时 App 自己也不带。控制面一律不带，等同于 App 的 gate 关闭路径，不伪造任何 App 头。

## 0. 来源

全部为仓库外的只读文件，没有执行。

| 标记 | 文件 | 说明 |
|---|---|---|
| M4 | `dist/electron-main/main-app.cjs`（0.79.4，3508308 字节，sha256 `8b68e8a6…b822b831`，见 [baseline-manifest.md](baseline-manifest.md)） | 用 prettier 格式化到仓库外的副本（sha256 `49bfb021…72bc1111`），下文 `M4:<行>` 指该副本行号 |
| M3 | 0.79.3 `main-app.cjs` 的同法格式化副本 | 只用来交叉核对 0.79.3 → 0.79.4 是否变化 |
| C4 | `dist/node-agent-coordinator/main.cjs`（0.79.4）格式化副本（sha256 `2f8581a1…e264e11b`） | `C4:<行>` |
| R4 | `dist/renderer/assets/index.eager-app-CqPrdYkq.js`（0.79.4 asar 原文件，sha256 `584ca95a…0ef46590`） | 已压缩，下文按代码片段引用 |
| P | 冻结 schema [`packages/protocol/baselines/schema-0.79.4/aiserver.v1.proto`](../../packages/protocol/baselines/schema-0.79.4/aiserver.v1.proto) | 第 5328–5352 行 |

asar 读取用 `tools/protocol/asar_extract.py`（纯读，不执行）。

## 1. 协议（P，已证实）

```proto
message EnsureSandBoxRequest {
  optional bool wake = 2;
  optional bool supports_asleep_box = 3;
}
message EnsureSandBoxResponse {
  string cluster = 1; string tenant_id = 2; string pod_id = 3;
  string network_token = 4; string exec_daemon_auth_token = 5; string exec_daemon_url = 6;
  string vnc_url = 7; string terminals_folder = 8; string fork_vnc_base_url = 12;
  optional bool image_update_available = 9; string gateway_url = 10; string gateway_token = 11;
  SandBoxRunState run_state = 13; optional bool egress_tunnel_ownership = 14; SandBoxImageInfo image = 15;
  string gateway_port_token = 16; string egress_tunnel_port_token = 17; string fork_vnc_port_token = 18;
}
enum SandBoxRunState { UNSPECIFIED = 0; ABSENT = 1; HIBERNATED = 2; RUNNING = 3; STARTING = 4; }
```

`EnsureSandBox` 在 `GrokBotService` 和 `SandBoxService` 上都有，签名相同；控制面用 `GrokBotService`（App 也是：M4:110461 `le(h.GrokBotService, t)`）。响应里大量是凭据和端点，见 §5。

## 2. App 的三种 EnsureSandBox 调用（M4，已证实）

整个 App 只有一个 `ensureSandBox` 调用点：box host 类 `xse` 的 `ensureBox(t)`（M4:110530–110589），`t` 原样作为请求。它的三个调用方决定了三种请求形状：

| 方法 | 位置 | 请求 | App 怎么解读结果 |
|---|---|---|---|
| `describe()` | M4:110508–110521 | `{ wake: false }` | 按 `run_state` 分成 running / hibernated / starting / absent，**不期望唤醒** |
| `locate()` | M4:110489–110494 | `{ supportsAsleepBox: true }` | `run_state == HIBERNATED` → `{kind:"asleep"}`，否则 running 并建立连接 |
| `connect()` | M4:110486–110488 | `{}` | 直接把结果当作可连接的电脑（`Pse(...)` 取连接信息），**没有 hibernated 分支** |

`locate()` / `connect()` 经 `ensureBoxPublishingPhase(t)`（M4:110495–110507）调用：先 `GetSandBoxRunState` 发布连接阶段，再 `ensureBox(t)`。`describe()` 直接调 `ensureBox`。

请求头（M4:110533–110535）：

```js
let o = this.parkMode?.();
n = await this.client.ensureSandBox(t, {
  ...(o === void 0 || o === "off" ? {} : { headers: { [v6]: o } }),
  ...
```

- `v6 = "x-sand-box-park"`（M4:1160）。0.79.3 里同一常量叫 `A6`（M3:1160），值相同，即 brief 里说的「park-mode 请求头 A6」。
- `parkMode()` 来自 `Tse(gates)`（M4:109566–109568）：`awayPark ? (presentPark ? "present" : "away") : "off"`。两个 gate 是 App 的 feature gate `sand_desktop_away_park` 和 `sand_desktop_present_park`（M4:109541–109542，M4:109976–109983 用 `checkFeatureGate` 读取）。
- 所以 `x-sand-box-park` 只有 `present` / `away` 两个取值，`off` 时不带头。**这是 App 自报的「停放策略」，不是设备凭据。**

0.79.3 对照（M3:110286–110335）：`connect()` 为 `ensureBoxPublishingPhase({})`，`locate()` 为 `{supportsAsleepBox: !0}`，`describe()` 为 `{wake: !1}`，与 0.79.4 相同。

## 3. 唤醒路径（App 「Wake」到 RPC）

### 3.1 渲染进程（R4，已证实）

- 需求常量：`El = {demand:"person"}`，`Dl = {demand:"background"}`。
- forever-box 状态机 `gsn(...)` 为每台电脑维护 `personWake`、`pendingEnsureWakeId`、`isPendingEnsurePerson` 等字段。`ensure` 实现（片段 `I=(r,i)=>{... let o=i?.demand==="person", ... l=o?N(r):null; ... r.pendingEnsureWakeId=l, ... e.ensureForeverBox({id:r.boxId}, i) ...}`）：带 `demand:"person"` 时先 `N(r)` 记一次 `personWake={id, outcome:"pending"}`，然后调 `ensureForeverBox`。
- 结果判定（片段 `P=(e,t,n)=>{... let i=n==="answered"||r.isRunningSinceStart===!0; e.personWake={...r,outcome:i?"woke":"failed"}}`，以及状态更新里 `isRunningSinceStart: r.state==="running"`、`failed` 后看到 running 改记 `woke`）：**App 判定唤醒成功的依据是之后读到 running**，这与控制面「读回 running 才算成功」一致。
- 电脑面板 hook `bsn(e)` 把 `ensure: () => n.ensure(e, El)`（即 person 需求）连同 `isWakePending` / `isWakeFailed`（来自 `personWakeOutcome`）交给 Computer 面板 `Kqn`。面板里具体哪个按钮绑定 `ensure` 没有逐个追到 JSX，**按钮 → `ensure` 这一步是推断**。

### 3.2 coordinator 与主进程（C4 / M4）

- `ensureForeverBox` 在 coordinator 的方法表里标为 `"person"`（C4:57802；M4:109192 同表），执行时 `foreverBoxStatusCommand("ensureForeverBox", …)`（C4:63054–63055、63347–63350）经网关连接发给电脑。（已证实）
- 主进程给 coordinator 提供网关连接：`resolveGatewayConnection: () => If.connectForPerson(Re)`（M4:164933）；`connectForPerson: async (f) => (await u(), await f.connect())`（M4:109958），`u` 先记一次 box intent。`Re = Z.wrap(Xr.guard(he))`（M4:164926），即 park 守卫包着 `xse`。（已证实）
- park 守卫 `guard()`（M4:109805 起）：没启用停放（`P()` 为假）时走 `Z(V)`；`live` 状态下最终进入 `ge()`（M4:109726–109736）：

  ```js
  V = await oe.locate();                 // EnsureSandBox({supportsAsleepBox:true})
  if (V.kind === "running") return V.connection;
  ... s.isBoxKeptAsleep = !0, te(), t === "live" → return await oe.connect();   // EnsureSandBox({})
  ```

  也就是：先用 `supportsAsleepBox:true` 探测，发现睡着、且当前仍需唤醒（`Mkn` 判定为 `wake`，M4:109546–109558，例如用户打开了电脑面板或 60 秒内有操作意图）时，再发**空请求** `connect()`，并把结果当作已连接的电脑。（代码已证实）
- `isBoxKeptAsleep`：`locate()` 返回 asleep 后被置为 true（M4:109731），之后 `parksUntilNeeded()` 为真，App 改为按需（`person` 需求）才唤醒；切账号时清零（M4:109792）。它只影响 App 自己何时发 `connect()`，不改变 `connect()` 的请求形状。

### 3.3 由此得到的结论

| 结论 | 等级 |
|---|---|
| App 的唤醒最终发的是 `EnsureSandBox({})`，`wake`、`supports_asleep_box` 都不设 | 代码已证实（唯一调用点 + 调用方） |
| `wake:false` 和 `supports_asleep_box:true` 是 App 的「不唤醒」探测；不设这两个字段时服务端会唤醒睡着的电脑 | **推断**（字段命名 + `connect()` 没有 hibernated 分支 + `locate()` 先探测后 `connect()` 的顺序）。App 从未发送 `wake:true`，所以没有证据支持改用 `wake:true` |
| App 在 gate 打开时会附带 `x-sand-box-park: present/away`；gate 关闭时不带头 | 代码已证实 |
| 不带 park 头时，空请求同样会唤醒 | **推断**（gate 关闭是 App 的默认路径之一；头的作用看起来是让服务端知道客户端支持「停放」，带上反而可能让电脑继续睡） |
| 唤醒成功的判据是之后读到 running | 代码已证实（R4 `personWake` 的 `woke` 判定） |
| `EnsureSandBox` 对 absent 电脑可能会新建电脑 | **推断**（`describe()` 把 absent 单列，`connect()` 无分支）；控制面因此对 absent 拒绝 |

## 4. 控制面实际行为（`computer.wake`）

```
GetSandBoxRunState {}                          # 读当前状态（dry-run 只做这一步）
  running    → already_running，不发写
  starting   → already_starting，不发写（--wait 时继续轮询）
  absent/0   → failed_precondition（退出 7），不发写
  hibernated → EnsureSandBox {}                # 唯一的写；无额外请求头；不重试
GetSandBoxRunState {}                          # 读回；--wait 时每 3 秒轮询到 running 或超时
```

- 成功：读回 running（退出 0）。不带 `--wait` 读回 starting：`code:"starting"`，退出 0。
- 仍 hibernated、超时、读回失败、等待被中断：`wake_unverified`，`outcome:"unknown"`，退出 10；EnsureSandBox 不会被重发，也不会转去 reset。
- EnsureSandBox 本身网络/超时类失败按写操作处理：`outcome:"unknown"`，退出 10。
- 不调用 `EnsureSandBoxWindow`、`RecreateSandBox`、`ForceRecreateSandBox`；不升级镜像（`image_update_available` 只原样报告）。

## 5. 凭据处理

`EnsureSandBoxResponse` 含 `network_token`、`exec_daemon_auth_token`、`gateway_token`、`gateway_port_token`、`egress_tunnel_port_token`、`fork_vnc_port_token`，以及 `vnc_url`、`gateway_url`、`exec_daemon_url`、`fork_vnc_base_url`、`cluster`、`tenant_id`、`pod_id`、`terminals_folder`。控制面只用白名单映射取 `run_state` 和 `image_update_available`，响应对象不展开、不记日志、不进错误 details。`test/computer-wake.test.ts` 在 mock 响应里放入假 token/URL，断言 CLI stdout/stderr、MCP 结果、SDK 结果和持久化的 mock 状态都不含这些值或字段名。

## 6. 未验证 / 风险

- 没有 live 验证：空请求是否真的唤醒、需要多久、唤醒是否计费，都未知。帮助和 README 已标注「静态推断，未 live 验证；唤醒可能产生费用」。
- 服务端可能因 App 没发过的组合（不带 park 头 + 空请求）返回与 App 不同的结果；控制面以读回状态为准，读不到 running 就报 `wake_unverified`。
- 渲染进程里「Wake」按钮到 `ensure` 的绑定没有逐个 JSX 节点追到（§3.1）。
