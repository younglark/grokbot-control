# Runbook：官方 App 发布新版本后重新还原协议

目标：在不运行任何官方代码的前提下，把新版本 schema 冻结成**新目录**，重新生成两个消费方，再核对 daemon 行为证据是否还成立。

## 0. 当前状态（0.79.3）

| 项 | 位置 |
|---|---|
| 不可变 App 归档（proto.cjs 提取） | `packages/protocol/baselines/schema-0.79.3/` + `schema-0.79.3.sha256.json` |
| **生成器实际输入** | `packages/protocol/baselines/schema-0.79.3-daemon-exec/` + `.sha256.json`：父归档 + 从 daemon bundle 紧凑描述符还原的 Exec* 闭包（增量，不改编号） |
| 生成器 | `packages/protocol/scripts/generate.cjs`（第 9 行选输入目录；先校验 sha256 清单，不符即报错） |
| 工具链 | Buf 1.50.0、protoc-gen-es 1.10.1、protoc-gen-connect-es 1.6.1（运行时 @bufbuild/protobuf 1.10.1、@connectrpc/connect 1.6.1，与 App 一致） |
| 输出 | 控制面 ESM JS `packages/grokbot-control/vendor/proto-gen/`；daemon TS→CJS `packages/local-exec-daemon/src/generated/`；两边 `SOURCE.json` 相同 |
| daemon 证据源 | `dist/local-exec-daemon/main.cjs` sha256 `5c1424ed…36be` → 格式化副本 `daemon.formatted.cjs`（187 625 行，sha256 `ad69a772…684c`），所有文档中的 **D:行号** 都指这个文件 |

哈希全值见 [baseline-manifest.md](baseline-manifest.md)。

## 1. 获取与校验（需要授权）

1. 按 [static-restore.md](static-restore.md) 下载官方包，记录版本、commit、各输入 sha256。来源不明就停止。
2. 用 `tools/protocol/asar_extract.py` 解到**仓库外**的临时目录。App 包、凭据、真实账户数据都不进仓库。
3. **只读文本，不执行**：不跑 `main.cjs`、worker、App 二进制，也不跑会加载 App bundle 的上游 compare/cross-wire 脚本。

## 2. 还原 schema

1. 对 `dist/electron-main/proto.cjs` 运行上游 `extract_proto.py`（younglark/grokbot-proto，版本见 baseline-manifest），要求零未解析/重定位引用。
2. 新建 `packages/protocol/baselines/schema-<new>/`：原始 `.proto`、`snapshot.json.gz`、SOURCE/NOTICE，再加同级 `schema-<new>.sha256.json`。**不得改写旧目录**（organization 测试会校验旧清单）。
3. Exec 闭包：在新 daemon bundle 中按字符串锚点（`ExecServerMessage`、`ExecClientMessage` 等，见 `schema-0.79.3-daemon-exec/SOURCE.json` 的 roots 与 added 列表）定位紧凑描述符 `$()` / 枚举 `ee()`，把缺的类型**增量**合并成 `schema-<new>-daemon-exec/`，同样配 sha256 清单。0.79.3 时这一步是一次性手工脚本，没有入库；请照 `exec-closure-meta.json` 的类型清单逐项核对。注意 0.79.3 曾踩过的坑：顶层 `FileDiff` 与嵌套 `EditFileResult.FileDiff` 结构不同。
4. 改 `generate.cjs` 的输入目录，指向新的 `-daemon-exec` 目录。

## 3. 影响面

1. 已用面：`python3 tools/protocol/used_surface.py --src packages/grokbot-control/src --old <old-subset.json> --new <new-snapshot.json>`，输出归档到 `docs/protocol/baselines/`。字段被删、改类型、改编号，或 RPC 签名变化，都会阻止升级。
2. 鉴权锚点：按证据更新 [auth-flow.md](auth-flow.md) 和 `packages/grokbot-control/src/auth/`。`client_id` 保持可配置，不伪造设备/策略头。schema 兼容不等于鉴权可用。
3. 更新 [compat-matrix.md](compat-matrix.md)、[surface-map.md](surface-map.md)。

## 4. 生成与校验

```bash
export UC_SKIP_OFFICIAL=1
npm ci
npm run generate && npm run generate:check
node tools/protocol/verify_generated.mjs packages/grokbot-control/vendor/proto-gen <解压后的 snapshot.json>
npm run build && npm run typecheck && npm test && npm run test:protocol-tools && npm run smoke:uc
npm run verify:package     # 打包真实公开 tarball，在仓库外安装并检查 bin 和 SDK 导出
```

daemon 的 oneof/cancel 测试和独立 golden 测试必须全部通过。

## 5. 重新锚定 daemon 证据（D: 行号）

1. 校验新 `dist/local-exec-daemon/main.cjs` 的 sha256。如果和 `5c1424ed…36be` 相同，daemon 行为没变，D: 行号继续有效，到此结束。
2. 如果不同：
   - 在仓库外生成 `npx prettier@3 --parser babel < main.cjs > daemon.formatted.cjs`，只格式化，不执行，并记录 sha256 和行数；
   - 压缩名每次构建都会变，所以用字符串锚点（错误文案、RPC 名、常量）重新定位 [local-exec/evidence/](../local-exec/evidence/) 中每条 D: 引用；
   - 逐项对照 [remaining-diffs.md](../local-exec/remaining-diffs.md) 和 [scenario-matrix.md](../local-exec/scenario-matrix.md)，把新差异写进 evidence 文件，并更新差异表；
   - `messages-worker.cjs` 同样处理（W: 引用）；
   - 官方程序预言机（oracle）需要单独授权和隔离，默认用 `UC_SKIP_OFFICIAL=1` 跳过。

## 6. live 与发布

- live 检查需单独批准，顺序是：独立登录 → 只读 RPC → 明确批准的一次性写入。离线/mock/codegen 检查不算 live 验收。不确定的写操作绝不盲目重试。
- 公开发布只有 `grokbot-control`（`gbc` / `gbc-mcp`），由 `v*` tag 触发 `.github/workflows/publish.yml`（文件名不能改）。私有 root/protocol/daemon 不发布。没有授权不打 tag。
