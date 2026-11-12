# App 0.79.3 → 0.79.4：静态比对结论

日期 2026-11-11（UTC+8）。全部为文本读取与哈希比对：没有运行 App、`main.cjs`、worker 或任何 App 内二进制，`UC_SKIP_OFFICIAL=1`。
外部材料不入库，位置见 [HANDOFF §6](../HANDOFF.md#6-开发机上的外部材料不入库)。

## 1. 来源

| 项 | 值 |
|---|---|
| 发布 feed | `https://api2.cursor.sh/updates/api/download/stable/linux-x64/sand`，2026-11-11 10:24 (UTC+8) 用 `curl` 免登录读取 → `version` 0.79.4，`commitSha` `7b5e3d87b3866229f111269975bc91bd8f3f7243` |
| deb URL | `https://downloads.cursor.com/grokbot/stable/7b5e3d87b3866229f111269975bc91bd8f3f7243/linux/x64/grok-bot_0.79.4_amd64.deb`（HTTP 200，Last-Modified 2026-11-10 13:03:03 UTC+8） |
| deb | 112689172 bytes，sha256 `cf0fd0032249cf08e75f6dff045766b5195078dd878d1eeed60a68c4d31a7a5a`（本地计算，未校验发布方签名）；`dpkg-deb -f`：grok-bot 0.79.4 amd64 |
| `app.asar` | sha256 `c35f7482c2f4e0f054c516be88f709b24f2b72007b6f2f700121cf22d644df50` |
| App `package.json` | version 0.79.4，`sandBuiltAt` 2026-11-10T04:58:05.991Z；依赖未变（`@bufbuild/protobuf` 1.10.1、`@connectrpc/connect` ^1.6.1） |

解包：`dpkg-deb -x`（不跑维护脚本）+ `tools/protocol/asar_extract.py`。

## 2. 哪些文件变了

asar 共 920 个条目，两版条目数相同；非 renderer、非 locale 的 164 个文件逐个比 sha256，只有 8 个不同：

| 文件 | 0.79.3 sha256 | 0.79.4 sha256 / 大小 | 实质变化 |
|---|---|---|---|
| `dist/electron-main/proto.cjs` | `929f17d2…2f8a` | `880f89188e42755f2b231edebc87ba86a62c1757f17ad62626d3e2f4373f4d93` / 1534639 | 两个 `CompleteMcpOAuth*` 紧凑描述符各加 1 个字段（见 §3）；其余只有 Sentry debug id |
| `dist/local-exec-daemon/main.cjs` | `5c1424ed…36be` | `c2b2c0edde611b5c3cfaf58a368ae021244f0e8fd873bceaac4f2868cfb66420` / 3998633（同长） | 76 字节不同：Sentry debug id（3 处）+ LAt 内置版本 `"0.79.3"` → `"0.79.4"`（D:78971）。见 §5 |
| `dist/local-exec-daemon/messages-worker.cjs` | `b6f5c672…667b` | **相同** | 无（W: 引用继续有效） |
| `dist/electron-main/main-app.cjs` | `d54cc236…8209` | `8b68e8a64a5458c50121a45289907e91769d07cd8f8a8a754e768a621c22b831` / 3508308 | MCP OAuth「继续授权」流程、Microsoft 365 连接器套件、团队切换后的插件目录缓存（新 gate `grok_bot_desktop_catalog_team_switch`）、telemetry `app_version` 字面量 0.79.4 |
| `dist/electron-main/main-core.cjs` | `910cc6bf…e34d` | `986ec9ad362f3fee5ccf7cc74ebd5edaf7cf03d13c8da26700bcfd3e6acf2d25` / 1161012 | 内置版本字面量 0.79.4（同 LAt 形状）、`builtAtMs`、新 gate 名、`microsoft_365` 套件 id |
| `dist/node-agent-coordinator/main.cjs` | `210bde6d…f09d` | `389f31bdd459baacb5c2f3f11cf69e85a121a1ec10f8be8f2d5fc19c70fb545c` / 1299048 | 只有内嵌 RPC JSON schema（deflate-raw + base64）：新增 `SandConnectorSuiteId` 枚举 `google_workspace \| microsoft_365`；格式化后行号不变 |
| `dist/electron-preload/preload.cjs` | `a4a86ffe…fb9e` | `3e953dddf18912dce1e498da99b60da4f541610a975df47c46ca9208f2390c11` | 套件 id 校验接受 `microsoft_365` |
| `dist/electron-main/main.cjs` | `a56fd4e2…9198` | `0c6d2c4f7726e2c5eec932f597d29f1315c5351d1690328cbab102aa0f491564` | 只有 Sentry debug id 与 code-cache `buildId` |
| `package.json` | — | — | `version`、`sandBuiltAt` |

方法：两版都用 prettier 3.9.10（babel parser）格式化到仓库外，再把 ≤5 字符的压缩标识符和 UUID 归一化后逐行 diff；字符串字面量另做多重集比较。

## 3. Schema 差异

`extract_proto.py`（grokbot-proto `49fd8ce`，sha256 `ab3ec201…2301`）：2923 messages / 387 enums / 7 services / 662 RPCs，unresolved 0、relocated 0。
snapshot.json sha256 `00712c32f2b611068fb75075ad0615297f648fe6f8e3e2363f1f9fb0a18a0961`。`diff_snapshot.py` 全文见 [baselines/full-schema-diff-0.79.3-to-0.79.4.txt](baselines/full-schema-diff-0.79.3-to-0.79.4.txt)：

- 新增消息 0，删除 0，枚举变化 0，RPC 变化 0（662 → 662）。
- 改变 2 个消息，均为**新增 optional 字段**：
  - `aiserver.v1.CompleteMcpOAuthRequest` + `3: optional string oauth_error`
  - `aiserver.v1.CompleteMcpOAuthResponse` + `6: optional string continue_authorization_url`
- 证据：proto.cjs 紧凑描述符 `"CompleteMcpOAuthRequest|1 state_id 9|2 authorization_code 9|3 oauth_error 9?"`、`"CompleteMcpOAuthResponse|…|5 connector_suite_result #0*|6 continue_authorization_url 9?"`。

冻结：新建 `packages/protocol/baselines/schema-0.79.4/` 与 `schema-0.79.4-daemon-exec/`（各配 sha256 清单），0.79.3 两个目录一字未改。
daemon Exec 闭包：0.79.4 daemon 的紧凑描述符与 0.79.3 逐字相同（`exec-closure-meta.json` 中 129 个新增类型的描述符字符串多重集全部相同；13 条 `exec_compacts` 全部在 0.79.4 bundle 中逐字出现），因此把 0.79.3 的「父目录 → daemon-exec」增量原样套到 0.79.4 父目录上，所有 hunk 干净应用；结果与 `schema-0.79.3-daemon-exec` 只差上面两个字段。详见该目录的 `SOURCE.json`。

生成：`generate.cjs` 输入改为 `schema-0.79.4-daemon-exec`。生成产物只变 `aiserver.v1_pb.{js,ts}`（两个字段）和两份 `SOURCE.json`。
`verify_generated.mjs` 对 0.79.4 snapshot：2923 messages、387 enums、464 GrokBotService RPC，2923 round-trip，0 errors；负对照（新代码对 0.79.3 snapshot）恰好报这 2 个消息字段数不符。

## 4. 对控制面的影响

- **已用面**：`used_surface.py` 以当前 `src`（20 个 RPC、70 个消息、24 个枚举）分别对 0.79.3 与 0.79.4 snapshot 取子集，两者完全相同，0 breaking。见 [baselines/used-surface-diff-0.79.3-to-0.79.4.md](baselines/used-surface-diff-0.79.3-to-0.79.4.md)、[baselines/used-surface-0.79.4.json](baselines/used-surface-0.79.4.json)。
  `CompleteMcpOAuth*` 不在控制面已用面内（控制面不做 MCP OAuth）。
- **合入 main（v0.6.0，`89ab6ed`）后复核（2026-11-12）**：main 期间新增了 `svc_aiserver.v1.DashboardService.proto` 生成输入（0.79.3 与 0.79.4 daemon-exec 目录中该文件 sha256 相同，`c15d65a8…2fcb`），控制面另外调用 DashboardService 的 `GetSandUsageStatus`、`GetGrokBotUsageBreakdown`（`src/ops/usage.ts`）。
  `used_surface.py` 只统计 `GrokBotService`：对合并后的 `src` 重新 `--write-subset`，结果仍是 20 个 RPC、70 个消息、24 个枚举，与 `baselines/used-surface-0.79.4.json` 逐项相同。两个 DashboardService RPC 不在该工具统计范围内（工具还会把 `localdash/server.ts` 的 `client.end()` 误报成 RPC `End`），改用全量 diff 核对：`baselines/full-schema-diff-0.79.3-to-0.79.4.txt` 覆盖全部 7 个 service、662 个 RPC，只有 `CompleteMcpOAuth*` 两个字段变化，所以这两个 RPC 及其消息在 0.79.3 与 0.79.4 之间不变。
  合并后重新生成产物与合并结果逐字节相同；`verify_generated.mjs` 对 0.79.4 snapshot：2923 messages、387 enums、556 RPC（464 GrokBotService + 92 DashboardService），0 errors。main 新增代码里出现的 `0.79.3` 只有 `bot create` 不传 title 的官方证据引用（已注明 0.79.4 相同），属于历史证据，保留。
- **鉴权**：`fingerprint.py` 在 0.79.3 与 0.79.4 的 main-app/main-core 上各输出 67 行锚点；把字节偏移和 ≤4 字符压缩名归一化后两份**完全相同**（login URL、redirectTarget、`/auth/poll`、`/auth/exchange_user_api_key`、`/oauth/token` 刷新、`sign_in_policy_violation`、默认 backend、client headers 等）。归一化 diff 中也没有任何鉴权相关改动。结论：`src/auth/` 无需修改。
- **请求头/版本串**：控制面不发送 App 版本号或 `x-cursor-client-*` 头（`rg` 核对 `packages/grokbot-control/src`），因此没有需要改的版本串。App 自己的 0.79.4 变化是 telemetry `app_version` 字面量（main-app）和内置版本兜底（main-core / daemon）。
- **sync**：coordinator 只改了内嵌 RPC schema 的连接器套件枚举；格式化后行号不变，`docs/control-plane/sync-format.md` 与 `transcript-body-0.79.3.md` 引用的 coordinator 证据仍成立。

## 5. daemon（D:）与 messages-worker（W:）

- 格式化副本：`/workspace/grokbot-node-analysis-0794/daemon.formatted.cjs`，prettier 3.9.10，**187 625 行**，sha256 `1ca01f7de6f515393fb104511897a9f46efaeb356754033bb9b6808f47707678`。同一 prettier 对 0.79.3 `main.cjs` 复现出既有的 `ad69a772…684c`，说明格式化可比。
- 与 0.79.3 格式化副本逐行 diff：行数相同，只有 4 行不同 —— 16、18（Sentry debug id）、**78971**（`return jPe(t) ?? jPe("0.79.4") ?? OAt;`）、187625（`//# debugId=`）。压缩标识符没有重命名。
  因此文档与代码里**所有 D: 行号原样有效**，无需重新锚定；`t184-helper-audit` 指向 0.79.4 副本（`DAEMON_FORMATTED=…0794/daemon.formatted.cjs`）4/4 通过。
- 唯一行为差异：LAt（D:78970–78972）在 `SAND_CLIENT_APP_VERSION` 缺失或不合法时的兜底版本从 0.79.3 变为 0.79.4，影响 `x-cursor-client-version` 与 user-agent 里的 `Sand/<v>`。App 正常启动时 main-core 会把 `SAND_CLIENT_APP_VERSION` 设为自身 `package.json` 版本（main-core `process.env.SAND_CLIENT_APP_VERSION = gs.version`），所以由 0.79.4 App 托管时线上值本来就是 0.79.4。
  已移植：`packages/local-exec-daemon/src/state/connection-exchange.ts` 的 `BUNDLED_APP_VERSION = "0.79.4"`，测试 `t166-mb-headers`、`t159-exchange-obsidian-cp` 更新并新增「env 优先于内置值」断言；门控 harness 的合成 App env 改为 `SAND_CLIENT_APP_VERSION: '0.79.4'`。
- `messages-worker.cjs` sha256 不变，W: 引用继续有效。
- 官方 oracle 夹具与 `scripts/oracles/*` 中写死的 `5c1424ed…` 是 0.79.3 官方程序的**历史运行记录**，保留不改；本次没有运行任何 oracle。
