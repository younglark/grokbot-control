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
| `npm run release:github` | 本地预览：检查、打包、生成父提交为空的 commit（默认不打、不推官方 `npm-v*` tag） |
| `npm run dev:gbc -- <args>` / `npm run dev:mcp` | 从源码运行 CLI / MCP（例如 `npm run dev:gbc -- dashboard --mock`） |

**每次跑测试前都先 `export UC_SKIP_OFFICIAL=1`。**

本地 `gbc dashboard` 的默认测试只检查 `packages/grokbot-control/dist/dashboard/` 打包树是否存在（先 `npm run build`），不启动浏览器，也不打 live 上游 RPC。默认套件不再依赖 Playwright / Chromium；CI 与发版工作流也不会安装浏览器。

## 测试分层

| 层 | 命令 | 说明 |
|---|---|---|
| 1. 默认套件 | `npm test` | 全部离线；daemon 用假对端、假时钟、合成 HOME/凭据 |
| 2. 单文件 | `cd packages/local-exec-daemon && npm run build && node --test test/<file>.test.cjs`；control：`cd packages/grokbot-control && node --import tsx --test test/<file>.test.ts` | 修改后快速验证 |
| 3. 门控替换验收 | `DROPIN_ACCEPTANCE=1 node --test packages/local-exec-daemon/test/dropin-acceptance.test.cjs packages/local-exec-daemon/test/dropin-extra.test.cjs`（先 build） | 启动**我们构建的** `dist/index.js` 对接合成后端，约 75 s（原版计时器不能缩短）。`DROPIN_EVIDENCE_DIR=<dir>` 输出观测 JSON；`DROPIN_ELECTRON=<npm 公开 electron>` 才跑 Electron 用例。矩阵见 [local-exec/dropin-acceptance.md](local-exec/dropin-acceptance.md) |
| 4. 冒烟 | `npm run smoke:uc`、`npm run smoke:electron` | Electron 路径用 `LOCAL_EXEC_DAEMON_ELECTRON=/path/to/electron` 指定，只能是公共 npm 的 Electron |
| 5. 协议 | `npm run generate:check`、`npm run test:protocol-tools` | 协议升级时另跑 `tools/protocol/verify_generated.mjs`，见 [protocol/update-runbook.md](protocol/update-runbook.md) |
| 6. 打包 | `npm run verify:package`；可用 `npm run release:github` 做本地预览 | 打包检查与预览安装树；正式 `npm-v*` tag 由 Actions 在推送 `v*` 后生成 |
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

- `workspaces.yml`：Node 20/22，job `timeout-minutes: 30`，`npm test` 一步 15 分钟。设置 `UC_SKIP_OFFICIAL=1`，避免误跑官方二进制。`npm ci --ignore-scripts` → 安装 ripgrep → generate:check → build → test → protocol-tools → smoke:uc → smoke:electron（无 Electron 时跳过）→ verify:package → `git diff --exit-code`。
- `auth-native-lock.yml`：`fs-native-extensions` 三平台预编译与源码构建矩阵。macOS 使用标准 arm64 标签 `macos-15`（`macos-14` 已于 2026-11-02 退役）。
- `release-github.yml`：job `timeout-minutes: 30`，Test 一步 15 分钟。推送 `v*` tag（不匹配 `npm-v*`）时，在 `UC_SKIP_OFFICIAL=1` 下跑 `npm ci`、`generate:check`、`build`、`npm test`，再把 `npm pack` 产物写成孤立 commit，打并推送 `npm-v<version>`。tag 已存在则失败，不 force-push。测试失败不会走到打 tag 那一步。`v0.2.0` 的一次发版因测试挂起被取消，没有生成 `npm-v0.2.0`；`v0.4.0` 的一次发版因 Playwright/Chromium dashboard UI 验收失败，没有生成 `npm-v0.4.0`；`v0.4.1` 的一次发版因 `npm pack --json` 被 vite 日志污染而失败，没有生成 `npm-v0.4.1`；不要改写这些源码 tag。
- 不再包含 `publish.yml`。推送任何 tag 都不会向 registry.npmjs.org 发布。

## 发布（GitHub tag，不再发到 npmjs）

控制面通过 git tag `npm-v<version>` 分发，tag 指向一个**没有 main 历史父提交**的安装树（`npm pack` 产物，已去掉 `prepack` / `build` 等生命周期脚本）。消费命令：

```bash
npx -y --package=github:younglark/grokbot-control#npm-v0.5.0 gbc --help
npx -y --package=github:younglark/grokbot-control#npm-v0.5.0 gbc-mcp
```

仓库是私有的，安装方需要能 `git clone` 的权限：`gh auth login`（HTTPS + credential helper）或配置 GitHub SSH key。包名 `grokbot-control` 与 bin 名 `gbc` / `gbc-mcp` 不同，必须带 `--package`，否则 npx 无法选定可执行文件。

正式发版步骤：

1. 在已合并的 `main` 上，工作区干净。需要先改版本时：`npm version <patch|minor|major> -w grokbot-control --no-git-tag-version`，审查后提交并推送 `main`。
2. 在准备推送的 `main` 提交上打源码 tag：`git tag -a v0.5.0 <main-commit> -m "grokbot-control 0.5.0"`，再 `git push origin refs/tags/v0.5.0`。不要从本机推送 `npm-v*`。
3. 等待 GitHub Actions 工作流 `release-github.yml` 跑完：它会打包、生成孤立 commit，并推送 `npm-v0.5.0`。同名 tag 已存在时任务失败，不会 force-push。测试失败不会出品 tag。
4. 根包、`protocol`、`local-exec-daemon` 仍是 private，不会被打进安装树。npmjs 上的 `grokbot-control@0.1.3` 已停止更新，本仓库不再向 npmjs 发版。

**推 `v*` 前确认 Actions 能跑完。** `v0.3.0` 的发版已成功生成 `npm-v0.3.0`。`v0.4.2` 的发版已成功生成 `npm-v0.4.2`。`v0.4.0` 的发版因 Playwright/Chromium 测试失败，没有生成 `npm-v0.4.0`；`v0.4.1` 打 `npm-v` 时因 pack JSON 被 vite 日志污染而失败，没有生成 `npm-v0.4.1`；不要改写这些源码 tag。若工作流无法跑完，先推 `v*` 不会生成 `npm-v*`，还会留下一个空的源码 tag。

本地预览（可选）：`export UC_SKIP_OFFICIAL=1` 后运行 `npm run verify:package`，再运行 `npm run release:github`（默认执行 generate:check、build、`npm test`）。stdout 为 JSON，包含孤立 commit 的 hash，可用 `npx -y --package=git+file://$PWD#<commit> gbc --help` 自检。默认不打官方 `npm-v*` tag。`--write-local-tag` 只在本地写验证用 tag，同样不要推送。`--skip-tests` 可跳过测试，但默认要跑。`--allow-branch` 允许在非 main 的干净分支上做预览。
