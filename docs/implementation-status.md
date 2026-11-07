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
