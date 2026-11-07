# Transcript body 解码证据：Linux App 0.79.3

2026-11-07（Asia/Shanghai）。只读静态解包/格式化；没有启动/require/eval App，没有读取真实凭据、App 私有数据库或调用生产 RPC。
这是代码证据，不是生产消息抓包；测试中的文本和 ID 全是 synthetic。

## 来源与定位

| 对象 | SHA-256 |
|---|---|
| 官方包内 resources/app.asar | `5e13b57664c39a36a84d75dcfcd94f7321a38beab18fa417d1df322e5b2fabe9` |
| `dist/node-agent-coordinator/main.cjs` | `210bde6d8e098d178617cef13700e5ef8e5eb2a5c7325a07b8720006b135f09d` |
| `dist/renderer/assets/index.eager-app-BXVg2FvL.js` | `24273b47aa4bc0d416ba6731a830b535bf5f4652e3923ddf9dbcbcd1a836c254` |

原始包在 `/workspace/grokbot-linux-0.79.3/extracted/opt/Grok Bot/resources/app.asar`。
本轮派生证据位于 `/workspace/grokbot-sync-evidence-0793/`（不入库）。用本仓库纯 Python ASAR reader 提取上述成员，
再 `prettier@3.9.10 --parser babel < main.cjs > coordinator.formatted.cjs`，仅格式化不执行 JS。
下文行号是这个派生文件，不是 minified 原件；稳定定位以原成员哈希 + 函数/字符串锚点为准。
App code/schema 不作为本工具源码执行或依赖；只实现最小数据 decoder。

## 外层 protobuf，内层 JSON UI entry：不是 agent.v1.UserMessage

1. `vendor/proto-gen/aiserver.v1_pb.js` 的 GrokBotTranscriptEntry：
   `seq / entry_kind / body:bytes / blob_hash / updated_seq / entry_id? / body_omitted`。
2. coordinator `Tt=(p,R)=>...`（formatted 55769–55783）执行：
   `C=JSON.parse(h.decode(p))`，然后 `N=_b(C)`，成功返回 `{...N,seq:Number(R)}`。
   同一函数作用域 `h=new TextDecoder`。没有 `.fromBinary(body)`、AES 或解密调用。
   **body 是 UTF-8 JSON 编码的 UI entry；不能拿 agent.v1.UserMessage 等 protobuf 来猜解。**
3. `_b`（54995–54997）先 `Are(n)`，然后做 UI 兼容性清理。
   `Are`（54868–54919）要求非空 string id，以 JSON 的 kind 分支验证 content/message/name/text/file_path 等。
4. renderer 的 `EF(e)` 有同样 discriminated entry validator；`dW(e)` 将 send-message 显示为 assistant、
   user-attachment 为 user；message 用自身 role（路由/共享消息还有 UI attribution 修正）。
   `TNn`/`ENn` 使用 tool-call 的 summary；状态/名称显示使用 name/status。
   各 entry 的 timestampMs 用于显示时间。
   `Szt(e)` 的 tool-call 分支直接使用 `e.id / e.status / e.summary?.length`，确认 summary/status 也属于原 entry 而非凭空拼接的另一协议；
   `jbt(e)` 对 user-attachment 返回 `{path:e.file_path,name:e.file_name}`，确认可选文件名来源。

本实现比 App 更严格：UTF-8 必须有效，JSON 必须通过已支持子集结构，非空 outer entry_kind 若与 inner kind 不同则 opaque，
id 限 1024 chars、解码 body 限 4MiB。未知类型不使用 App 的宽松 fallback，也不把任何可打印字节当正文。
message 的 role 按源数据保留；send-message 的 assistant 和 attachment 的 user 标记 role_source=ui-kind，
仅表示 UI 类别，不证明真实作者身份。顺序/作用域仍采用外层 uint64 seq + 请求 agent/session，绝不使用 JSON body.seq/session。

## 已支持字段

| JSON kind | 正文/参考字段 | 角色来源 | 证据 |
|---|---|---|---|
| message | content:string；role:string 可选；timestampMs；suppressed 标记 | body.role；不擅自改写路由消息角色 | Are / EF / dW / xmn |
| send-message，message.type=text | message.content:string；timestampMs | renderer UI-kind=assistant | Are / EF / dW / xmn |
| tool-call | name:string；可选 status/summary:string（null 视为无值） | 无冒充 message role | Are / EF / TNn / ENn |
| notice | text:string；timestampMs | 只标 kind，不冒充 system 作者 | Are / EF |
| user-attachment | file_path:string；可选 file_name；timestampMs | UI-kind=user | Are / EF / dW / jbt |

工具 arguments/result/output 的完整结构没有在这条 UI entry 路径得到确认，**只显示名称/状态/summary，不声称是完整工具结果**。
未知工具名可以按数据显示，绝不会执行工具。附件路径只是文本引用，不打开/下载/拼成归档写路径。

未支持：非 text send-message（widget/secret-request/email-draft/approval 等）、mcp-app、event、voice-call、
feedback、labeler-question、未来种类、结构不符/不合法 UTF-8/非 JSON/超解码上限、body 省略/缺失。
这些都保留原 bytes/raw/wire，Markdown 明确占位。inline JSON 成功仅记 plaintext_json（包裹层可读），
其他情况记 encryption unknown；不会因解析失败而宣称是密文。协议其他文本字段的 FieldState.ENCRYPTED 不能套用到这里。

## inline / omitted / blob 的区别，以及未扩张的边界

coordinator `Ee`（formatted 55815 之后）优先 body；否则收集 blobHash；bodyOmitted 的 seq 会用同一 agent/session/generation
重新 List，`beforeSeq=seq+1,limit=1`，精确找回该 seq。blob 路径通过 `readBlobs` 读取，随后也交给同一个 Tt JSON decoder。
`j3` 的 client.readBlobs 用 PresignSandBoxStoreReads，relPaths=`blobs/<hash>`，fetch arrayBuffer 返回原始 bytes。
静态链中没有独立的 body 解密步骤；这不证明服务端磁盘/传输没有加密。

本次不增加 blob/presign 或额外补正文网络请求；只有已拉到的 inline body 能解码。blobHash 是 transcript 正文间接引用，
不应误称为普通附件，也不应当作已验证 SHA-256 或自由下载 URL。缺失正文仍是硬缺口。

coordinator 的 box gateway `getAgentTranscriptTail` 复用同一 List + hydrate + Tt 路径，不是另一个可任意替代的公开文本历史 RPC。
SearchGrokBotTranscripts 的 snippet 是搜索摘要，不是逐 seq 的全历史正文；本实现没有混用它补会话。
因此不引入额外 scope/顺序来源，不复用 App gateway 凭据。

## 合成 fixture 与测试

`test/fixtures/transcript-ui-0.79.3.synthetic.json`：**synthetic code-derived UI JSON，不是生产抓包**。
测试用真实生成的 GrokBotTranscriptEntry schema 编码/解码其外层 protobuf，再验证 JSON decoder、原 bytes 保存和 Markdown/rg。
负例用真实 agent.v1.UserMessage 编码证明“另一个 genuine protobuf 类型”不能被错误当作本路径正文。
大工具 summary、未知类型、乱码、omitted、scope/seq 不信 body、cached decode 不可信、Markdown/HTML/terminal 转义均有回归。
正文可读能力是静态协议证据 + synthetic genuine-envelope 验证；真实服务分页/正文覆盖比例/字段变种仍待 live 验证。
