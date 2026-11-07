# 实现状态（2026-11-07，JST）

本轮修订基于939e4f7，包含以下修复与隔离验收证据。

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
npm test **128/128**；build/typecheck通过；test:protocol-tools **5/5**；git diff --check通过。
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
未实现Watch/deletes/clear/cursorTooOld实时补偿、omitted/blob正文补读、chunk fallback、artifact/任意workspace/外链下载。
全历史行/正文/附件完整性仍unknown；不证明跨页事务快照一致，不保证头页之外旧行变更被刷新。
账户ID无verified whoami，本次仅隔离验收声明namespace，不冒充server_verified稳定身份；操作者必须自行核对生产账户。
