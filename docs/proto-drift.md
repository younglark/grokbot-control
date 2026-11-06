# Proto drift 清单（0.78.4 vs App 0.79.2 静态）

| 项 | 状态 |
|---|---|
| CreateGrokBotTemporalAgent I/O = CreateGrokBotAgentRequest | 已用 |
| App 另传 visibility/teamId/botBuilderRequested | **不在** 0.78.4 Request → 本实现**不发送** |
| ListGrokBotSubagents（非 ListGrokBotAgentSubagents） | 已对齐生成客户端 |
| sidebar_sections_base 冲突线上码 | App 映射 SaveConflict；精确码待真机 |
| delete 后 sidebar 残留 | 未证 |
