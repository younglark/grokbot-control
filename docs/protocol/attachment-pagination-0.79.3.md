# App 0.79.3：附件与分页实现依据

只静态读取，不执行App。原成员资源来自官方Linux0.79.3包；派生文件在/workspace/grokbot-sync-evidence-0793（不提交包体）。

## 分页
coordinator.formatted.cjs：
- _s 55503：默认session省略；qe 55963：generation0省略、beforeSeq可选、limit+1；gW/SW 55466：hasMore/nextBeforeSeq。
- ge 55789：精确seq补正文使用beforeSeq=seq+1/limit1，支持排他边界解释；Ee 55822补omitted/blob。
- readBlobs 53230：PresignSandBoxStoreReads(blobs/hash)，不是附件。
- uu/Oe 56306/55944：entries/deletes合并；Ds 56376/56390：cleared/cursorTooOld authoritative重建。
- wk 56441：afterUpdatedSeq游标；56557 WatchGrokBotTranscripts。
- updatedSeqLocked在55975/56126保存，56899用作加入跟踪条件，不能解释成跨页snapshot锁。
App是UI按需历史+实时尾，不是一次完整导出。本工具不引入Watch，保留历史并显式unknown。

## 路径与来源
main-core.cjs常量别名：V_=/home/box，hK=sand-data，AK=${V_}/${hK}，G_=${V_}/agent-data；模块41导出两root。
electron-main/main-app.cjs（minified单行，符号稳定定位）：
- J6e/gvn/hvn，字符offset约2283192：两root、agentDir、attachments/assets、64hex.ext、file URL严格校验；canonical为model-visible root。
- H6e/Q6e约2276288：fallback absolute path、normalize、root/bucket限制。
- Bvn约2284606：STORE要求size/expires为safe integer和非空etag，https默认；NOT_IN_STORE/NO_STORAGE区分。
- jie.ge约2287777：按路径agentDir分组Resolve，生产Store请求未携带session，canonical alias携带agentDir；本工具更保守按session隔离ref/请求。
- jie.ue约2288748：redirect:error，403刷新Resolve一次；jie.J约2289379：Range+段长度检验；q使用If-None-Match/304。
- W6e约2277065：ReadGrokBotAgentAttachmentChunk，4MiB段长、totalSize变化失败，feature gate；不应对NO_STORAGE盲目扩大读取范围。
- 附件服务fe/J：先length0获totalSize，循环readAttachmentChunk写文件；失败删除半成品。
renderer index.eager-app-BXVg2FvL.js：rQ/jbt：user-attachment(file_path/file_name)，send-message附件(message.type=attachment,url,file_name)。
外部URL/artifact还有独立适配，不表示所有message.url都能交Resolve。

## 安全差异
本工具不复制App缓存/凭据，不读本机alias路径；远端alias只经鉴权RPC解析。
不假设64hex就是服务端内容hash，落盘自己计算SHA-256；immutable语义未live证实，因此每次重新验证。
文件名长/中文只影响显示元数据，refs用canonical-path hash无120byte ID组件限制。
附加public-IP DNS pinning是本工具下载policy，不声称App同样实施。
