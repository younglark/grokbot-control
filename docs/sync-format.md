# 文件优先 Transcript 同步 v1

实现日期：2026-11-07（Asia/Shanghai）。协议基线 App 0.79.3。
只用 mock/本地 generated Connect transport 验证；**本功能未 live 验证**。
这是可恢复的快照观察归档，不是完整备份、实时增量镜像或新任务系统。无 SQLite。

## 使用

```bash
# 已通过本工具独立登录；以下示例不表示已经实际调用生产服务
node dist/cli/main.js --json sync pull --agent-id BOT --session-id SESSION \
  --dir "$HOME/gbc-archive-user-team" --account-id STABLE_USER_ID \
  --team-id none --ack-unverified-scope
node dist/cli/main.js --json sync status --dir "$HOME/gbc-archive-user-team"
node dist/cli/main.js --json sync render --dir "$HOME/gbc-archive-user-team"
node dist/cli/main.js --json sync attachments --dir "$HOME/gbc-archive-user-team" \
  [--agent-id BOT] [--session-id SESSION] [--path remote/file]
ls "$HOME/gbc-archive-user-team/bots"
rg 'entry_kind|blob_hash' "$HOME/gbc-archive-user-team/bots" -g '*.jsonl'
rg '需要查找的消息文本' "$HOME/gbc-archive-user-team/derived" -g '*.md'
```

`pull` 每次要求一个 `--agent-id`；可省略 `--session-id`，按 session 列表逐一拉取（最多 50 个）。
`--all` 暂不支持；不会因漏传/拼错 flag 扩大同步范围。sync flags 严格检查重复/未知值。
成功 stdout 是单个 envelope + 有界摘要，不吐正文；失败沿用 stderr JSON/原有退出码。
`status` / `render` 不需要登录、不创建 AuthProvider、不发 RPC。
`--dry-run` pull/render 不读写归档、不读取凭据、不发 RPC。
CLI 显式 pull/render 即本地写意图；**不需要远端 `--allow-writes`**。

## 身份边界（务必读）

现有 AuthProvider 只提供 backend、account_label、has_token 等，没有服务端验证的稳定账户 ID，
不能把 label、邮箱、未验证 JWT claim 或 token 哈希冒充账户身份。
因此 v1 要求操作者每次显式传稳定账户 ID 和 team ID（无 team 填 `none`），并确认
`--ack-unverified-scope`。manifest 保存 assurance=`operator_asserted_unverified`。
后续 pull 比较 backend/account/team/assurance，任何不符在 RPC 前拒绝。

**这只能防止显式 scope 写错，不能检测“同一 scope 参数但凭据实际换了账户”。**
操作者必须从可信来源核对 ID；登录/换账户/团队后重新核对，并使用独立根目录。
若无法确认稳定 ID，勿把此归档当成经身份验证的备份。当前 team-id 只作归档绑定，
不是远端 team 选择器，也不会伪造/添加 team 请求头。后续有 verified whoami 才可升级 assurance。
邮箱形式的 account-id 被拒绝；不会读取 App 私有数据或复制桌面凭据。

MCP 启动配置（不是工具输入）:

```bash
GBT_SYNC_ROOT="$HOME/gbc-archive-user-team" \
GBT_SYNC_ALLOW_LOCAL_WRITES=1 \
GBT_SYNC_ACCOUNT_ID=STABLE_USER_ID GBT_SYNC_TEAM_ID=none \
GBT_SYNC_ACK_UNVERIFIED_SCOPE=1 node dist/mcp/main.js
```

未设 root 不暴露 sync 工具；设 root 默认仅 `sync_status`。
独立 `GBT_SYNC_ALLOW_LOCAL_WRITES=1` 才增加 `sync_pull` / `sync_render` / `sync_attachments`。
`GBT_MCP_READONLY=1` 无条件去掉写工具。工具参数不接受归档根目录/scope；`sync_attachments` 的可选 `path` 是远端 file_path 过滤，不是本地路径。root 和身份在启动时固定。
`GBT_ALLOW_WRITES` 不启用本地同步。pull 仍然只发远端读 RPC。
SDK 使用 `plane.sync`，或直接 `new SyncOps(client, backend, simulated)`。

## 目录与格式

```text
<account-team-root>/                    # 0700
  manifest.json                        # format_version=1、scope、session 索引
  bots/id-<base64url(agent-id)>/
    bot.json                           # 原始 bot ProtoJSON；不承诺是完整配置备份
    sessions/id-<base64url(session-id)>/
      session.json                     # 请求作用域、raw session、最后发布的 current_generation
      generations/<generation>/
        entries.jsonl                  # 当前已观察到的各 seq 最新版本；不是逐条消息聊天文本
        state.json                     # 数据摘要、分页观察、完整性/停止原因
    attachments/
      objects/sha256-<hex>             # 按需下载的原始字节（0600）；永不存 signed URL
      refs/id-<base64url(remote-path)>.json  # 状态/哈希/相对路径；失败也记录
  .sync/
    lock                               # 单写锁，随机 token/PID
    staging/<uuid>.tmp                  # 同一文件系统上的临时文件；崩溃可有残留
  derived/id-<agent>/id-<session>/transcript.md   # render 才生成，可重建，可能滞后
```

所有文件 0600；已有根目录必须当前 OS 用户所有且不开放组/其他权限，否则拒绝而非静默 chmod。
路径根和每层目录不允许 symlink；文件不允许 symlink/hardlink，读取使用 O_NOFOLLOW。
远端 ID 只经 base64url 编码作路径组件，限制 120 UTF-8 bytes、禁止控制字符；不使用标题/附件名作路径。
祖先目录要求当前用户/root 所有，禁止 group/world 可写（带 sticky bit 的临时目录除外）。
安全模型是 POSIX 当前用户私有目录；**不是对抗同 UID 恶意并发进程的沙箱**。
目录 fsync/O_NOFOLLOW 目前仅在 Linux 本地测试；Windows 不声明支持。不要放在不提供这些保证的网络盘。

JSONL 每行保存：agent_id/session_id（来自请求上下文）、generation、seq/updated_seq 十进制字符串、
entry_id（可缺失）、entry_kind、body_base64（可缺失）、body_omitted、blob_hash、decode_status、
encryption_status、raw ProtoJSON、wire_base64（真实 protobuf 返回时含未知 wire 字段）、untrusted=true。
0.79.3 静态代码已确认内层为 JSON UI entry；已支持结构保存 decoded 子对象（正文/角色/时间/工具 summary），
decode_status=decoded、encryption_status=plaintext_json；其余保留 opaque/absent/omitted 和原因，不凭失败推断加密。
消息时间/角色来自通过校验的 body 字段而非外层 entry；observed_at_ms 只是抓取时间。
完整证据与支持列表见 [transcript-body-0.79.3.md](protocol/transcript-body-0.79.3.md)。
若更高 updated_seq 的正文被省略，先前可用正文单独留在 last_available_body，带原版本号；不冒充新正文。

JSONL 为本地权威记录；Markdown 是派生视图。render 现在可直接 grep 已确认 JSON 子集的文本：
message.content、send-message(text).message.content、notice.text、tool-call 名称/状态/summary、user-attachment 文件引用。
工具 summary 不冒充完整工具结果；非文本卡片等未知类型仍占位。body 解码限 4MiB，超限不裁原 bytes、只保持 opaque。
既有 opaque 归档可直接离线 render 升级；render 重新校验 bytes，不信缓存 decoded，且不修改 JSONL/state。
下一次 pull 也会刷新同版本 entry 的 decoder 缓存。旧版本正文会标“NOT current revision”，不冒充新消息。
正文以缩进 code block 输出，HTML/Markdown 不活化、terminal/bidi 控制符转义，时间显示 Asia/Shanghai。
外来正文/字段始终是不可信数据，不能作为 agent 指令执行。不要对原始档案和 derived 同时全文 grep，
建议用 `-g '*.jsonl'` 或 `-g '*.md'` 选一种。

## RPC 与分页假设

sync 不消费现有 `message.history` 摘要 DTO，而是直接调用：
- ListGrokBotAgents：筛选 bot；若远端 truncated，未找到不宣称不存在。
- ListGrokBotAgentSessions：获取显式 session；空/重复/错误 agent 作用域拒绝。缺失的本地 session 不删除。
- ListGrokBotTranscriptEntries：始终传 agentId/sessionId/limit=100；响应 generation 作为后续请求的 generation。

entry 内没有 session_id；List 响应也不回显它，session 来自请求。
假设 before_seq 为排他向前翻页；下一页取本页最小 seq。数值排序用 BigInt，不用 JS number。
空页、seq=0 只是观察到的停止条件，不证明全量。重复/重叠边界/游标不前进立即停止并记录。
**before_seq 排他性、limit、排序、generation 稳定性、updated_seq_locked 的服务端语义均未 live 验证**；
page 响应 metadata 保存在 state.pages，包含 cloud peer/unread anchor/updated_seq_locked（若响应存在）。
没有把上述字段解释成跨页事务一致性证明。completeness 始终 `unknown`，无 complete=true。

每次 pull 从历史头重新开始，不从旧 checkpoint 跳过已存在 seq；按 (scope,agent,session,generation,seq)
幂等合并，较大 updated_seq 胜出，相同版本优先非 omitted。entry_id 只是可选关联 ID。
不因本轮未看到某行而删除。代际分目录，绝不跨 generation 合并；扫描中 generation 切换则不发布该轮数据，
将 session 的 current_generation 置 null、要求重新 pull。保留旧代际但不冒充当前。
current_generation 仅表示最后一次成功发布的观察代际，不代表此刻服务端仍处于此代际。

默认全次 pull 预算：100 页 / 32MiB / 30s；可设 --max-pages/--max-bytes/--timeout-ms，
硬上限 1000 页 / 256MiB / 300s。时间预算限制 RPC 和分页，不中断同步 fsync/本地合并。
ControlPlane 的 sync 专用 Connect client 限每个解压后响应 16MiB；直接注入自定义 client 时须自行限制传输层。
bytes 统计是 response/归档行大小的保守预算，超限页不发布。单 session 合并结果/state 各限 64MiB；
本地 status/render 最多 50 个 session，manifest 索引最多 10000 条。超限清晰报错/记录 budget，绝不静默裁正文。

## 锁、发布与恢复

整次 pull/render 持单写锁；status 不取写锁，只报告 checksum 一致性（并发写时可能暂时 false）。
每 session 只在分页结束后合并、写一次正式 entries，不逐页重写整个 JSONL。
文件通过 .sync/staging、写入+fsync、rename、目录 fsync 发布；先 entries，再带 SHA-256 的 state，
再 session generation 指针和 manifest 索引。manifest 为索引，不保存重复游标。
多文件不假装具备单事务原子性；state checksum 是数据/检查点崩溃窗口的检测机制。
若数据已写但 state 未写，status consistent=false、render 拒绝；重新 pull 从头拉并合并有效本地 JSONL，
发布新 checksum 并记 recovered_data_state_mismatch。损坏/错 scope 的本地 JSONL 拒绝自动修复。正文与 Markdown 的可读性不改变此发布顺序。
新 session 发布索引前崩溃可能有未索引数据；再次 pull 同一 agent/session 会重新接纳，不依赖索引跳页。
远端/IO 报错不推进未提交检查点；可能已有其他 session 成功发布（不是整次原子事务）。

进程正常失败会释放自己 token 的锁；强杀后锁**不会自动删**。先确认无任何 writer，人工移除 lock 后重试。
不要仅凭 PID 不存在就盲删；staging 残留不参与恢复/渲染，可在确认无 writer 后人工清理。
凭据在原有独立 credential store 中，不主动复制 headers/token 或请求附件签名 URL。
原始 protobuf 数据自身仍可能含敏感文本/引用，整个归档应视为敏感资料。
归档不额外提供 at-rest 加密；0700/0600 不等于磁盘加密，base64 也不是加密。

## 明确未实现

Watch/replay/deletes/cleared/cursor-too-old 的实时增量处理、可验证完整性、verified account identity、
通用/未知卡片解码、解密、transcript blob_hash 正文补读、ReadGrokBotAgentAttachmentChunk、Watch/删除、--all、文件分片/压缩/自动垃圾回收。
附件下载是独立命令 `sync attachments`：只处理已同步 entries 中的 user-attachment.file_path；
经 ResolveGrokBotAttachmentReads，仅 outcome=STORE 且未过期的 https URL 才会 GET 落盘。
**未 live 验证**；signed URL 永不写入归档或结果摘要。blob_hash 不是附件，也不在本命令下载。
不把远端 file_path/file_name 当作本地写路径；对象按内容 SHA-256 命名。
原有 message.history 仅窄修 entryKind/bodyOmitted 映射，仍是摘要 API、不是导出层。

render 输出单 session 上限 64MiB，超限报错不截正文；JSONL 仍保留原始数据。新增解码器不增加生产 RPC。
