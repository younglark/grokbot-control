# 开发与测试指南

## 环境

- Node ≥ 20（CI 跑 20 和 22），Python 3（`tools/protocol` 只用标准库）。
- `rg`（ripgrep）：daemon 的 ls 树测试会用到系统 `rg`，没有时相关用例跳过。注意 App 本身不带 `rg`。
- 可选：`unshare`（network-change 门控用例）、`xvfb-run`（Electron `utilityProcess` 用例）。
- 只在仓库根执行 `npm ci`；子包没有自己的 lock，不要在子包里 `npm install`。

## 常用命令（仓库根）

| 命令 | 作用 |
|---|---|
| `npm ci` | 安装（含 tree-sitter 的 install 脚本，已在根 `allowScripts` 批准） |
| `npm run generate` / `npm run generate:check` | 从冻结协议生成 / 校验两份生成代码 |
| `npm run build` | 构建所有 workspace |
| `npm run typecheck` | 类型检查 |
| `npm test` | control + daemon + `test/organization.test.mjs` |
| `npm test -w grokbot-control` / `npm test -w local-exec-daemon` | 单包测试 |
| `npm run test:protocol-tools` | `tools/protocol` 的 Python 单测 |
| `npm run smoke:uc` | daemon UC 通道冒烟（本机回环，合成数据） |
| `npm run smoke:electron` | 用外部 Electron 跑 daemon 交接冒烟；没有 Electron 时跳过 |
| `npm run verify:package` | 真实 `npm pack` 公开包并在隔离目录安装，检查 bin / SDK 导出 |
| `npm run dev:gbc -- <args>` / `npm run dev:mcp` | 从源码运行 CLI / MCP |

**每次跑测试前都先 `export UC_SKIP_OFFICIAL=1`。**

## 测试分层

| 层 | 命令 | 说明 |
|---|---|---|
| 1. 默认套件 | `npm test` | 全部离线；daemon 用假对端、假时钟、合成 HOME/凭据 |
| 2. 单文件 | `cd packages/local-exec-daemon && npm run build && node --test test/<file>.test.cjs`；control：`cd packages/grokbot-control && node --import tsx --test test/<file>.test.ts` | 修改后快速验证 |
| 3. 门控替换验收 | `DROPIN_ACCEPTANCE=1 node --test packages/local-exec-daemon/test/dropin-acceptance.test.cjs packages/local-exec-daemon/test/dropin-extra.test.cjs`（先 build） | 启动**我们构建的** `dist/index.js` 对接合成后端，约 75 s（原版计时器不能缩短）。`DROPIN_EVIDENCE_DIR=<dir>` 输出观测 JSON；`DROPIN_ELECTRON=<npm 公开 electron>` 才跑 Electron 用例。矩阵见 [local-exec/dropin-acceptance.md](local-exec/dropin-acceptance.md) |
| 4. 冒烟 | `npm run smoke:uc`、`npm run smoke:electron` | Electron 路径用 `LOCAL_EXEC_DAEMON_ELECTRON=/path/to/electron` 指定，只能是公共 npm 的 Electron |
| 5. 协议 | `npm run generate:check`、`npm run test:protocol-tools` | 协议升级时另跑 `tools/protocol/verify_generated.mjs`，见 [protocol/update-runbook.md](protocol/update-runbook.md) |
| 6. 打包 | `npm run verify:package` | 发布前必跑 |
| 7. 官方 oracle | 默认被 `UC_SKIP_OFFICIAL=1` 和 lab 缺失跳过 | 会执行官方 main.cjs，**未经用户明确授权不得运行** |

团队习惯的每轮测试预算：门控 harness 一次、根 build 一次、根全量 `npm test` 一次、单文件重跑最多一次。失败要如实记录，不要反复重跑到变绿。

## 写代码和测试的规则

- 先找原版证据（D: 行号），再改代码；改完把结论写进对应文档（见下节），并加测试钉住。
- 测试只用合成数据和假对端；需要计时的用可注入时钟，不要长时间真实 sleep。
- 不在生产代码里加测试钩子；需要注入的点用构造参数（现有的 `clock`、`createClient` 等）。
- 新测试文件按主题命名。已有的 `t1xx-*.test.cjs` 是按轮次命名的历史文件，保持原名即可。
- 协议相关改动只能通过重新生成，不能手改 `src/generated/` 或 `vendor/proto-gen/`。

## 文档放哪里

| 内容 | 位置 |
|---|---|
| daemon 某个机制的原版证据（D: 行号、移植方式、测试） | `docs/local-exec/evidence/<主题>.md` |
| daemon 与原版的差异结论（已修 / 有意不移植 / 不可达） | 更新 [local-exec/remaining-diffs.md](local-exec/remaining-diffs.md) 的总表 |
| 门控验收新增步骤 | [local-exec/dropin-acceptance.md](local-exec/dropin-acceptance.md) |
| 控制面行为/契约 | `docs/control-plane/` 或 [protocol/protocol-map.md](protocol/protocol-map.md) |
| 某一轮的过程、测试数字、事故 | 提交信息；确有长期价值才追加到 `docs/history/` |

主文档只写当前结论，不写「第几轮做了什么」。

## CI

`.github/workflows/`：

- `workspaces.yml`：Node 20/22，`npm ci --ignore-scripts` → 安装 ripgrep → generate:check → build → test → protocol-tools → smoke:uc → smoke:electron（无 Electron 时跳过）→ verify:package → `git diff --exit-code`。CI 上没有 oracle lab，官方用例自然跳过。
- `auth-native-lock.yml`：`fs-native-extensions` 三平台预编译与源码构建矩阵。
- `publish.yml`：推送 `v*` tag 时发布 `packages/grokbot-control`（npm Trusted Publishing / OIDC）。文件名不要改，npm 端绑定了它。

## 发布（只有公开包）

1. 工作区干净，`npm run build && npm test && npm run verify:package` 通过。
2. 获得发版授权后：`npm version patch -w grokbot-control --no-git-tag-version`，审查后提交，再显式打 `vX.Y.Z` tag 并推送。
3. 根包、`protocol`、`local-exec-daemon` 都是 private，不发布。已发布的版本不要重推同名 tag。
