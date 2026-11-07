# 文件优先观察归档（无 SQLite）

基线 App 0.79.3。身份仍为 operator_asserted_unverified，不是 server_verified。
本地目录0700，文件0600，凭据独立保存；不得把真实归档提交仓库。

## CLI
```sh
gbc sync pull --agent-id BOT --dir /absolute/archive --account-id STABLE_ID --team-id none --ack-unverified-scope --page-size 100 --max-pages 100
# Optional body recovery; defaults off for backwards-compatible network cost
# Add --hydrate missing --max-hydrate-requests 32 --hydrate-max-bytes 8388608 --hydrate-max-body-bytes 4194304 to pull
gbc sync status --dir /absolute/archive
gbc sync render --dir /absolute/archive
gbc sync attachments --agent-id BOT --dir /absolute/archive --account-id STABLE_ID --team-id none --ack-unverified-scope
# --session-id SESSION 限命名会话，省略为agent下已归档会话；--path 为远端canonical alias过滤
```
`message send/status` 省略 --session-id 使用默认会话，MCP/SDK一致。附件不在pull中默认下载。
--dry-run不读写归档、不登录或RPC。未知/重复flag拒绝。CLI显式命令即本地写授权，不需远端allow-writes。
MCP root/身份启动固定：GBT_SYNC_ROOT、GBT_SYNC_ACCOUNT_ID、GBT_SYNC_TEAM_ID、GBT_SYNC_ACK_UNVERIFIED_SCOPE=1；
另需GBT_SYNC_ALLOW_LOCAL_WRITES=1暴露pull/render/attachments；GBT_MCP_READONLY=1排除所有本地写工具。
GBT_ALLOW_WRITES不打开本地同步写开关。scope在任何下载RPC前核对backend/account/team/assurance。
此绑定不能发现操作者在相同声明ID下实际换凭据。换账户必须重新确认，使用独立archive。

## 布局
```
manifest.json                        # 账户声明、session索引、下轮session轮转位置
bots/id-<agent>/bot.json
bots/id-<agent>/sessions/default/     # 默认会话：wire session_id=""
bots/id-<agent>/sessions/id-<session>/
  session.json                       # current_generation指针；代际变化则null
  generations/<generation>/
    entries.jsonl                    # retained observations，不是当前有效镜像
    state.json                       # checksum、head刷新时间、backfill游标/阶段/覆盖观察
bots/id-<agent>/attachments/
  objects/sha256-<content-hash>        # 完整内容，不存signed URL
  refs-v2/<sha256(session)>/<sha256(canonical-path)>.json
bodies/objects/sha256-<content-hash>  # transcript body, NOT a user attachment
.sync/lock
.sync/staging/<uuid>.tmp
derived/<agent>/<session>/transcript.md
```
ID组件base64url，默认session用default。远端路径不作为本地写路径。
旧format_version=1归档继续可读；旧无scope/session的refs不迁移为可信当前ref，必须重新Resolve下载；旧对象可保留历史。
旧state缺backfill字段从head重建。数据/state checksum不符重拉，从head恢复，不信旧游标。
status一致仅证明本地checksum，不代表服务端完整或最新。Markdown可重建，pull/attachments后需render。

## 分页、backfill与真实性
List以before_seq排他回翻，首次省略before_seq；generation=0省略与App对齐。seq/updated_seq以uint64字符串和BigInt排序。
page-size默认100，1..500；max-pages默认100硬顶1000；max-bytes默认32MiB硬顶256MiB；timeout默认30s硬顶300s。
一个命令共享预算，session稳定排序+跨命令轮转，预算耗尽不推进未处理session。每session单独记录本次页数/字节。
第一次从head取页，接已有最早backfill游标继续；预算仅1页时下轮backfill，再下轮head，防止重复头页饿死深历史。
head刷新与backfill进度分开；head不会把更老游标倒退。空页只是结束观察，不编造complete。
不前进/重叠边界停止并记录；generation变化不跨代合并，current_generation=null要求重拉。
JSONL先落盘fsync/rename，再写state校验和，最后manifest；异常可重放，绝不宣称跨文件事务。
所有单session entries/state及render输出各限64MiB。历史不因未返回就删除；旧generation保留但不在current指针中。

**completeness始终unknown**。未实现Watch/deletes/cursorTooOld、明确删除同步；
无法证明跨页事务一致性，也不保证旧行变更均被刷新。backfill到空页不等于全文正文/附件全量完整。
保留的历史行可能已被远端删除，视图明确标注retained observations，不能当当前镜像。

## 按需附件
来源仅已确认UI entry：user-attachment.file_path、send-message(message.type=attachment).message.url。
只支持App已证实store alias：/home/box/{agent-data|sand-data}/agents/<safe-agent-dir>/{attachments|assets}/<64hex>.<ext>，
规范为agent-data；严格file://可转换。中文/长显示文件名保留为数据，绝不作为本地写路径。任意本机绝对路径、../、非规范file URL拒绝。
外部链接、workspace任意路径、cloud-composer artifact、未知卡片明确unsupported，不任意抓URL。
每agent/session/canonical-path独立ResolveGrokBotAttachmentReads。仅STORE+合法size/expiry/nonempty-etag+HTTPS才GET；
NOT_IN_STORE/NO_STORAGE不盲fallback。重复/冲突Resolve行拒绝。ReadGrokBotAgentAttachmentChunk后续再做。
每次都Resolve；已下载对象先校验本地hash，再条件GET If-None-Match。304且etag/size匹配才复用；新内容新hash，旧对象留历史。
旧ref不被当作服务端最新证明。403最多再Resolve一次，总预算/截止时间共用。
流式写private staging，边读hash/计量，超过单文件/总预算立即取消并丢弃staging；失败耗用仍计网络预算。
默认单文件32MiB（硬128）、命令总64MiB（硬256）、命令30s（硬300）。安全schema与元数据枚举本地扫描仍是有限CPU工作；本地fsync不可强杀。
全GET只接受200；304仅条件请求；不接受未请求的206。完整size/hash成功后fsync/rename才发布ref/entry/state。
每次归档改写同样64MiB检查。all failed -> attachments_failed，部分失败 -> partial，详情结构化给出；没有附件是0结果，不能冒充下载验收通过。
signed URL/Bearer从不落盘或回显；下载GET不附带Connect鉴权。只允许公开HTTPS、标准443、无userinfo/hash，DNS解析拒绝私有/loopback/reserved结果且钉住解析地址，TLS校验正常，拒绝重定向。
这信任已登录backend提供的数据、OS DNS/TLS与注入SDK代码；不是同UID恶意进程沙箱。custom fetch仅SDK测试/可信集成，CLI/MCP不暴露绕过policy开关。
0700/0600不是磁盘加密，原始记录及base64都可能有明文，整个archive按敏感信息保护。

## 证据与验收
详见 protocol/attachment-pagination-0.79.3.md。静态代码证据不能替代live验证；每次真实验收单独记录范围与结果。

## 正文补读（CLI/MCP 共用 SyncOps）
`pull --hydrate missing` / MCP `sync_pull({hydrate:"missing"})` 才补读，默认 `off`。
不扩大 Watch/Room/附件来源，不调用 App、不读取其数据库/凭据。
- inline bytes 始终优先，包括空 bytes；body_omitted 标志仍作为原始观察保存。没有 inline 时优先已有 blob ref，再考虑 omitted 精确重读。
- omitted 请求严格绑定原 agent/session/generation，`before_seq=N+1,limit=1`。App `ge` 精确重读**始终传 generation（含 0）**。返回必须唯一且 seq/kind 相符；entry_id 若本地已有则必须一致。若同 seq/identity 但 `updated_seq` 更大：先把新观测 merge 进归档再对该版本补读，不丢弃。精确同版本才取 body/blob。UINT64_MAX 无合法 successor，显式失败。响应无 session 回显，只能验证请求 scope。
- generation 变更不发布本轮混代条目，已有历史不删；session 指针置 null，要求重拉。条目版本变更只标补读失败，不把新版本 body 配给旧条目。
- blob 仅取已观察 entry/reread 的 opaque ref，验证为安全单段后请求 `PresignSandBoxStoreReads({rel_paths:["blobs/<ref>"]})`。该 RPC 无 agent/session 参数，是已鉴权 account/team store scope，不添加猜测字段。响应一条请求必须恰好一条完全匹配路径，无缺失/多条/冲突/额外路径；顺序不作为映射依据。
- 不假设远端 ref 是 SHA256 或不可变；下载后的 **本地内容** 才计算 SHA256。命令内同 agent/session/generation 的一次恢复批次共享同 ref 的网络观察，记录不声称内容跨时刻不可变。无跨命令按 opaque ref 缓存。已经保存的 body 只在同一原始 entry 版本绑定（manifest backend/account/team/assurance 摘要 + agent/session/generation/seq/updated_seq/entry_id/kind/原 blob/omitted/inline）和本地 hash 全部相符时使用，manifest scope由读取者重算，不信JSONL自报的scope摘要；含义是保留的同版本观察，不是服务端现在的最新证明。
- signed URL 只来自该 store RPC，不接受 CLI 任意 URL。有效 expiry（至少余 1s）+公开 HTTPS/443，无 userinfo/fragment，DNS pinning/私网拒绝/无重定向，无 Bearer/Connect headers；URL 不落盘。过期/缺失 expiry 直接 partial；HTTP403 最多新 presign 一次，404/206/非200失败。这个403有限刷新是本工具的保守扩展，不声称 App blob reader 自带此重试。
- 流式写 .sync/staging，下载按已读 bytes（含失败）计量、超限取消、fsync/rename；无需猜测 presign 未提供的 size/etag。Content-Length 若提供需为安全整数、不超过预算且最终stream长度匹配，最终 JSON decoder 仍限4MiB，不实现任何解密或自选压缩协议。

预算：`--max-hydrate-requests` 默认32/硬256（omitted重读、presign及403刷新均计入；这是 transcript pages 之外明确独立的额外 API 预算）；`--hydrate-max-bytes` 默认8MiB/硬64MiB；`--hydrate-max-body-bytes` 默认/硬4MiB。
同时受 pull 剩余 max-bytes 和统一 deadline 约束，网络响应 protobuf JSON 估算字节与 blob bytes 都计量；超限响应/stream 的已发生耗用可能超过额度，之后不再启动新补读。普通 pull 页数仍由 max-pages 控制；最多2次发现RPC + max-pages + max-hydrate-requests。
传输层读响应 cap 沿既有16MiB；没有未公开的“inline limit”参数。失败不会清空归档，下一次开启补读会重新尝试历史 pending 条目；仅当**本轮**补读 RPC/传输失败（`hydration.failed>0`）或 generation_changed 时 `ok:false,code:partial,outcome:known_failure`（exit9）。解码器 unsupported / opaque 单独计入 `decode_failed`/`unavailable_or_unsupported`，**不影响退出码**。确定性失败（body_unavailable/exact_row_missing/body_version_changed 等）对同一 binding 记 `retry:"never"`，后续轮次跳过以免饿死新条目；本轮新观测优先，其余按 seq 从新到旧。off 不发补读。

格式兼容：manifest format_version=1 不变；entry 的 `hydration.format_version=1` 和 state 的 `body_hydration_format=1` 为可选增量字段。没有它们的旧归档按原始 body 解码；未知格式/坏 binding/hash/base64 拒绝使用缓存正文，离线输出 opaque，不猜读路径；未知未来 hydration 格式原样保留、补读报 partial，不破坏未来证据。原 `raw/wire_base64/body_base64/body_omitted/blob_hash` 保留；补读记录含 archive_scope_sha256/context/source/observed_at/attempts/retry、`object_rel`+`content_sha256`（正文以内容寻址对象为准，不在 hydration 再内联 body_base64）。reread 只保留 wire/meta，raw JSON **剥离 body**，避免三份正文撑爆 64MiB。
JSONL 也保留经确认 schema 解码的明文 decoded.text，便于 rg 中文；status/render 从原始 inline 或验证后的 hydration bytes 重建，不信 cached decoded。额外正文证据若挤出64MiB session预算，保留原行并降级archive_body_budget/partial（已完成对象可能成为孤儿），不删除原始条目来腾空间。对象先写，entries 后写、state 最后写；崩溃可留下孤儿对象但不能发布半截 body，校验不符重拉；无自动 GC/deletes。
state/status 的 `body_coverage` 分开给 retained_rows、observed_inline/omitted/blob_ref、hydrated_version_bound、decoded、unavailable_or_unsupported。omitted 与 blob 观察可重叠，这些不是互斥全集；hydrated 成功取得 bytes 也不代表 JSON/schema 解码成功。历史行覆盖、正文覆盖、当前有效成员/最新状态是三回事，completeness/current membership 仍 unknown。
每session JSONL（包括原始与补读证据的重复存储）、state、Markdown 均仍限64MiB，超限拒绝发布，不默默截正文；较小的新下载预算不删除过去已保存的合法观察。文件0700/0600不等于加密。
