# 协议：归档、还原方法、契约

本仓库基于哪个 Grok Bot 协议、如何从新版 App 重新还原，以及 SDK/CLI/MCP 如何安全更新。

| 文档 | 内容 |
|---|---|
| [update-runbook.md](update-runbook.md) | **App 更新后重新还原协议的操作步骤**（含 daemon D: 行号重新锚定） |
| [baseline-manifest.md](baseline-manifest.md) | 上游提取器 commit、App 版本、输入/产物哈希、daemon bundle 哈希 |
| [static-restore.md](static-restore.md) | 静态还原方法：下载 → 解包 → schema → 锚点 |
| [surface-map.md](surface-map.md) | 本仓库用到的 RPC/消息 → SDK/CLI/MCP，附证据等级 |
| [protocol-map.md](protocol-map.md) | App 动作 ↔ RPC ↔ CLI/MCP 契约、错误/重试/写安全 |
| [auth-flow.md](auth-flow.md) | 独立 Cursor 登录/poll/刷新，代码锚点 |
| [transcript-body-0.79.3.md](transcript-body-0.79.3.md) | 0.79.3 transcript 正文（body/blob/omitted）读取证据（路径被代码引用） |
| [attachment-pagination-0.79.3.md](attachment-pagination-0.79.3.md) | 0.79.3 附件与分页证据 |
| [app-0.79.4-delta.md](app-0.79.4-delta.md) | App 0.79.3 → 0.79.4 静态比对：来源哈希、变化文件、schema/鉴权/daemon 结论 |
| [compat-matrix.md](compat-matrix.md) | 版本兼容、create/sidebar 漂移、未 live 验证项 |
| [references.md](references.md) | 外部参考 |
| [冻结 schema](../../packages/protocol/baselines/) | `schema-0.79.4`（不可变归档）与 `schema-0.79.4-daemon-exec`（当前生成器输入）；0.79.3 两个目录保留为历史冻结 |
| [baselines/](baselines) | 历史版本的 used-surface / 全量 schema diff |
| [tools/protocol](../../tools/protocol/README.md) | 离线脚本：ASAR 读取、锚点指纹、used-surface diff、生成代码校验 |

## 证据等级

| 标记 | 含义 |
|---|---|
| **S** | 对官方 App 构建做静态逆向（不是官方 API 文档） |
| **O** | 本仓库离线验证（fake transport / 本地 fake 后端） |
| **L** | 对线上服务确认（写明日期和具体内容） |

O 通过不代表 L。

## 不在仓库里的东西（有意为之）

- App 安装包、ASAR、完整或格式化后的 bundle（从官方下载，见 static-restore）。只归档哈希、锚点和少量 schema 派生数据。
- 凭据、token、client_id、账户数据、bot ID、登录 URL。
- `.proto` 注释：App 只带紧凑描述符，原始注释和文件布局无法还原。
