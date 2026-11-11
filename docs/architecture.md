# 仓库架构

## 包与依赖方向

```text
packages/protocol (private，构建工具)
   │  scripts/generate.cjs 读冻结 .proto，生成两份产物
   ├──► packages/grokbot-control/vendor/proto-gen   ESM JS，随公开包发布
   └──► packages/local-exec-daemon/src/generated    TS，由 daemon 编译成 CJS

packages/grokbot-control (public)   SDK ← CLI(gbc) / MCP(gbc-mcp)
packages/local-exec-daemon (private) 独立进程；不 import CLI/MCP
packages/headless-node              仅设计：未来宿主 = 控制 SDK + 以「进程」方式监督 daemon
```

规则（`test/organization.test.mjs` 会检查）：

- 根 `package.json` 是 private 的编排包，只有一个 `package-lock.json`。
- 任何包都不能有 `workspace:` / `file:` 运行时依赖，也不能在运行时 import 兄弟包。生成产物故意在每个消费方各存一份，schema 和生成器只有一份。
- 两份 `SOURCE.json` 必须完全相同；冻结目录的每个文件都被 sha256 清单钉住。
- 公开包的 `files` 只有 `dist`、`vendor/proto-gen`、`README.md`；没有 `prepare` / `install` 脚本，`prepack` = `npm run build`。
- 鉴权只在控制面包里。daemon 不共享控制面的凭据或权限状态。
- `headless-node`、`deploy/headless` 只能是文档，不能出现假的可执行实现或 Dockerfile。
- 所有 Markdown 相对链接必须能解析（`packages/protocol/RESTORE.md` 是标明了的历史记录，除外）。

## 协议生成链路

```text
官方 App app.asar
  └─ dist/electron-main/proto.cjs（紧凑描述符，只当文本读）
       └─ extract_proto.py（上游 grokbot-proto @ 49fd8ce）
            └─ packages/protocol/baselines/schema-0.79.4/              冻结，不可改（0.79.3 目录保留为历史）
                 + daemon bundle 中的 Exec* 描述符（增量合并）
                 └─ packages/protocol/baselines/schema-0.79.4-daemon-exec/  当前生成输入，冻结
                      └─ npm run generate
                           Buf 1.50.0 + protoc-gen-es 1.10.1 + protoc-gen-connect-es 1.6.1
                           运行时 @bufbuild/protobuf 1.10.1、@connectrpc/connect(-node) 1.6.1（与 App 相同）
```

- 线上编码、方法路径、Connect 封包全部由库负责，生产代码里没有手写 protobuf。
- 仍然自己实现的只有：业务 JSON（UC 内层 `serverMessageJson`/`messageJson` 由生成的 `ExecServerMessage`/`ExecClientMessage` 编解码）、Box 通道的 JSON/SSE 帧，以及纯 HTTP 的连接交换。
- 测试用的独立编解码器（`test/helpers/wire-oracle.cjs`）和 Python 生成的 golden 刻意与生产代码分开，用来交叉验证。
- App 更新后的流程见 [protocol/update-runbook.md](protocol/update-runbook.md)。

## 控制面（packages/grokbot-control）

`src/{auth,connect,ops,sync,cli,mcp,dto,testing}`：CLI 和 MCP 都是共享 SDK（`ops`）上的薄适配层，结果契约和退出码统一。细节见 [control-plane/architecture.md](control-plane/architecture.md)。

## local-exec-daemon（packages/local-exec-daemon）

```text
src/
  index.ts        入口：handoff → crash guard → discovery → Box / UC 生命周期（对应原版 cqr → lgt）
  bootstrap/      crash-guard、handoff（IPC / parentPort）、boot-env（env 与继承 fd 清理）
  settings.ts     settings 全 schema、durable 文件日志
  state/          discovery、connection（+交换）、lease、fs-write（原版 cp）、node-proxy、standing 信号
  exec/           handlers（Tft 的 4 个执行器）、shell-session、background-shell、denylist、sandbox、
                  spawn-workload（Ko/Ud）、ls-ripgrep、exec-codec、output-channel（Ki + 心跳）
  box/            Box SSE provider、messages-op
  uc/             UC provider、reply-lanes（oee）、approvals、file-source、outage-ledger、
                  ai-tool-discovery、local-tools、obsidian、sealed（AES-GCM 密封文件）、credential
  trace.ts        可选 UC_TRACE_FILE 诊断（未设置时 no-op）
  generated/      生成代码 + SOURCE.json
scripts/          uc / electron 冒烟；oracles/（隔离 oracle 研究脚本与 golden，不在默认测试里执行官方代码）
test/             node:test 套件；helpers/ 里是假对端、独立编解码器、门控 harness
```

角色、能力和原版对照见 [local-exec/overview.md](local-exec/overview.md)。
