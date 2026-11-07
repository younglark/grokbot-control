# 文件优先观察归档（无 SQLite）

基线 App 0.79.3。身份仍为 operator_asserted_unverified，不是 server_verified。
本地目录0700，文件0600，凭据独立保存；不得把真实归档提交仓库。

## CLI
```sh
gbc sync pull --agent-id BOT --dir /absolute/archive --account-id STABLE_ID --team-id none --ack-unverified-scope --page-size 100 --max-pages 100
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

**completeness始终unknown**。未实现Watch/deletes/cursorTooOld、明确删除同步、omitted单seq补读、blob_hash正文补读；
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
