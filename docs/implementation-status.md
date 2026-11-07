# 实现状态（2026-11-07，SGT）

## Token 自动刷新加固（t47u，未提交）
基于 main@04c1893 本地实现，对照 App 0.79.3 分析最小可靠状态机：
- 凭据 provenance/revision/session 绑定；client_id 仅 GBT_OAUTH_CLIENT_ID 或登录持久化，不硬编码、不从 JWT 猜。
- getAccessToken：缺/非法 exp、临期<5min、force → 刷新；进程内 singleflight + 跨进程锁；锁内重读复用。
- 刷新：固定 HTTPS `/oauth/token`、禁 redirect、20s、schema 校验；CAS 保存旋转 pair。
- 失败分类：网络/5xx/429 保留+cooldown；shouldLogout 锁内救援后再清，绝不回退已撤销 token。
- logout/login 与 refresh 共享锁；Linux kernel flock 分离 refresh/mutation 两把锁；不按 mtime 强拆、不 unlink 锁。
- CLI `auth refresh [--force]` 区分 already_fresh / 实际刷新；whoami 离线；MCP `auth_refresh` 非 READONLY。
- RPC401：更新凭据供下次，原错误返回；写 0 重放；只读白名单最多 1 次 refresh+retry；预 RPC 失败 `rpc_dispatched=false`。
- staticTokenProvider 永不自动 refresh / 无磁盘 refresh。
默认不做 live refresh 验收（mock 覆盖）。

# 实现状态（2026-11-07，SGT）

前轮修订基于939e4f7；正文补读本轮基于 main@8a6cf21，以下分别记录，不扩大 live 声称。

## 本轮修复
- 保留前次5个未提交修复：update/delete通过List将UUID映射server-id；默认会话使用wire空session和sessions/default。
- store alias严格规范化两App root/file URL，refs使用session/path SHA-256，中文文件名仅元数据；不读本机alias路径。
- streaming staging/hash/大小/总预算/截止时间、strict STORE/HTTP、403最多重Resolve一次、公开HTTPS DNS pinning、无Bearer给下载URL。
- attachments绑定backend/声明account/team/ack；旧无作用域refs不直接信任；scope仍operator_asserted_unverified。
- user-attachment与send-message attachment两种已证实来源；外部URL/未知路径unsupported。
- 每次Resolve+条件GET，304先本地完整性检验，远端etag/size匹配才复用；旧对象保留历史。
- head刷新与generation内backfill游标分离，单页调用交替，两种session跨调用轮转；budget耗尽不推进未处理session。
- JSONL/data-before-state恢复、64MiB边界、partial/failure结构化；视图标注retained observations，非当前镜像。

## 回归
前轮 npm test **128/128**；正文补读后 **174/174**（原128项保留，新增约46项（含starve/merge/partial/gen0/体积回归））。build/typecheck通过；test:protocol-tools **5/5**；git diff --check通过。
测试覆盖scope拒绝、严格路径/URL/metadata、超限stream取消/失败字节计数、截止时间、403/304/同路径版本、坏对象重下载、symlink、backfill进展/公平/崩溃恢复。

## 隔离真实后端验收
证据在仓库外/workspace/gbc-live-fix-20261107132918（0700），不得提交真实archive。
只创建本轮唯一临时bot，发送1条测试指令，没有修改/向现有bot发消息，没有修改共享sidebar或联系第三方。
- 真实默认会话generation0：page-size=1/max-pages=1，8次pull，4个唯一seq。
- 实际before边界排他、0 generation省略；backfill cursor从4→3→2→1→空页观察，重抓head不阻止backfill进展。
- bot发出send-message attachment，file:// alias，显示中文名“验收测试.txt”。下载36 bytes，固定测试标记/中文/本地hash均匹配。
- 第二次真实Resolve+条件GET得到not_modified，body 0 bytes；同hash对象复用。render包含本地ref；status checksum一致。
- 实际CLI status/render成功；MCP readonly sync_status成功且不暴露写工具。
- finally删除临时bot，最终27个bot与初始27个ID相同，测试ID不在列表，初始缺失0。

## 仍未覆盖（不得扩大声称）
真实服务没有返回命名session，本轮命名+default公平只有回归测试证据；没有凭空创建不确定会话。
真实user-attachment上传、同路径可变覆盖、URL403/过期、超限下载等没有live执行；有mock/静态覆盖不等于live通过。
未实现Watch/deletes/clear/cursorTooOld实时补偿、chunk fallback、artifact/任意workspace/外链下载；omitted/blob 已可选补读，live 来源限制见下。
全历史行/正文/附件完整性仍unknown；不证明跨页事务快照一致，不保证头页之外旧行变更被刷新。
账户ID无verified whoami，本次仅隔离验收声明namespace，不冒充server_verified稳定身份；操作者必须自行核对生产账户。

## 正文补读本轮（main@8a6cf21 上未提交修改）
- shared SyncOps + CLI/MCP `hydrate=off|missing`，默认off，pure dry-run/status/render 无RPC；额外API/page统计与共享总字节/截止时间，single body硬4MiB。
- `src/sync/hydrate.ts`：inline优先、同session/generation/seq精确omitted List与updated_seq/entry_id/kind验证；uint64 max无successor拒绝；blob只使用观察ref和store presign严格逐路径映射，无猜hash算法/任意URL。
- 原始wire/protojson不覆盖；hydration记录独立保存manifest scope摘要、entry版本binding、来源、时间、reread证据、bytes/本地内容SHA256。跨命令只用同版本绑定的历史观察，不按opaque hash建立全局缓存；同批同ref共享一次网络观察。
- 私有流式staging、DNS pinning、URL过期拒绝、HTTP403最多1次新presign、无Bearer/URL落盘；正文对象与用户附件分离。额外正文证据超session存储预算降级partial并保留原行，不因optional body挤掉原始行；崩溃可能保留孤儿对象，无GC。
- observed inline/omitted/blob、hydrated bytes、decoded正文覆盖独立统计；失败/未知schema显式partial（exit9），不宣称全文/当前镜像。旧归档离线兼容；未知/坏body缓存不解码，不猜路径。
- 新回归覆盖中文JSONL/MD rg、精确scope/version/uint64、坏JSON/未知schema、大body/硬budget、过期/重复/错配presign、403上限、同blob去重、跨manifest scope拒用缓存、超时取消、symlink/hardlink、对象已提交后的中断恢复、MCP gates/CLI dryrun。

### 本轮隔离 live（2026-11-07 14:03–14:04 SGT）
证据仅仓库外 `/workspace/gbc-body-live-20261107140312`，目录0700/文件0600。
新临时bot、仅1条固定无隐私测试指令；本地输出128行中文/测试文件（5888 bytes），不读现有bot transcript、不联系第三方、不改sidebar。
- PASS：正常create/send/default session、2页List、4条唯一inline记录，全部确认schema可解码；原始覆盖4、omitted0、blob0、hydrated0，completeness仍unknown。
- PASS：offline CLI render/status/checksum（凭据目录指向不存在路径）、rg中文正文、assistant固定测试marker；MCP stdio readonly sync_status成功且不暴露写工具；scope不一致在transcript RPC前拒绝。
- SKIP：真实omitted恢复、真实blob presign/下载。正常RPC request没有inline字节上限参数，本次合理小的正文/工具输出未自然触发；不造未公开参数、不把mock算live。
- PASS（顺带现有实现）：send-message attachment中文文件名，5888 bytes固定中文/marker/本地SHA256一致；第二次Resolve+条件GET为not_modified，0 body bytes。
- SKIP：命名session（服务器列表0，当前无create-session操作，不编造ID）；user-attachment上传、真实403/过期/下载超限/代际切换仍未验证。
- PASS cleanup：finally删除精确测试ID并确认不存在；初始27、最终27，完整ID集合相等，无初始ID缺失；未盲重试未知写。
身份仍是隔离验收用operator_asserted_unverified namespace，不能冒充服务端验证账户；生产使用需操作者核对真实稳定account/team。

## 审查修复（t43u）
- P2 starve：同seq更大updated_seq先merge再补读；确定性失败同版本`retry:never`跳过；本轮新观测优先+seq新到旧。
- P2 partial：仅本轮hydrate失败/generation_changed→partial/exit9；decoder unsupported只计数。
- P3体积：hydration/reread不内联重复body_base64，对象+sha256装载。
- P3 generation0：精确重读始终传`generation:e.generation`（含0）。

## t47u 继续修复：跨进程刷新合并（2026-11-07，Asia/Shanghai）
- 独立 Linux util-linux `flock` refresh 锁覆盖有界 HTTP；mutation 短锁保护 login/logout/CAS。等待者以进入时 session/revision 为基线，force 也复用已旋转 pair。
- kernel 锁不 unlink、不按 mtime 猜 stale；父进程退出/崩溃关闭 helper stdin，OS 释放；锁等待超时结构化错误。依赖 Linux `flock`/sh/cat，缺失 fail closed。
- 429/网络/timeout/5xx cooldown 条件持久化，跨进程等待后不风暴重试。HTTP400 invalid_grant 明确 terminal；新登录不被旧 terminal 清除。
- 响应运行时字段校验、非空白 access_token；exp 必须 safe integer；准确300s不刷新（规则为<300s）。配置/malformed不fallback。
- READONLY 排除所有 authTool 凭据写工具，保留离线 auth_whoami。
- 新增真正 Node 子进程协同 mock HTTP：4进程 force 仅1次请求、旋转复用、logout/login保存竞争、owner SIGKILL恢复、timeout、invalid_grant。
- 当前完整 npm test **196/196**（基线174，新增22个顶层测试；子进程场景在1项测试内多断言）；typecheck/build、protocol-tools **5/5**、diff --check通过。无live refresh、无commit/push。
- 测试边界：login/logout竞争的跨进程用例以受控 fixture store clear/save模拟原子落盘时机；provider共享mutation锁的行为另有单进程实例测试。没有真实OAuth服务器验收。

## t50u Native advisory-lock替换（2026-11-07，Asia/Shanghai）
- 保留此前auth修改；fs-native-extensions **1.5.3**（Apache-2.0）替换外部flock/sh/cat。接口独立在auth/lock.ts，永久lock file，try_lock+异步有界等待，无mtime抢锁/daemon/helper。
- Linux `F_OFD_SETLK`、macOS `flock`、Windows `LockFileEx`源码已核实；GrokBuild fs2语义对照见[auth-lock.md](auth-lock.md)。Linux原生锁命名空间不同于旧flock，升级必须停止全部旧进程。
- 实际provider logout/login也用Node子进程测试（替代前轮fixture直接写）；native owner crash、mtime回拨不抢锁、cancel/timeout不释放他人锁、event loop响应与缺binding fail-closed已测。
- Node20/22预编译+三平台源码构建CI配置，无发布/上传；Mac/Windows及源码重构建未在本机执行。Linux x64运行验证不代表其它平台通过。
- 不新增用户电脑依赖；正常npm ci直接使用integrity锁定npm tarball预编译，无Rust/C++要求；非覆盖平台需维护者CMake/C工具链源码构建。

最终验证：npm test **199/199**；npm run typecheck / build通过；protocol-tools **5/5**；git diff --check通过。当前工作树未提交，未commit/push、未真实refresh。源码构建矩阵为配置证据，不冒充已执行结果。
