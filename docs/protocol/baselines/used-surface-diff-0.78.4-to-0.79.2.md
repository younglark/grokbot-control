# Used-surface diff (aiserver.v1.GrokBotService)

RPCs used by `src`: 15


## Messages

- `aiserver.v1.CreateGrokBotAgentRequest`
  - additive +18: optional aiserver.v1.GrokBotAgentVisibility visibility
  - additive +19: optional int32 team_id
  - additive +20: optional bool bot_builder_requested
- `aiserver.v1.GetGrokBotUserRuntimeSettingsRequest`
  - additive +1: bool after_main_agent_change
- `aiserver.v1.GrokBotAgent`
  - additive +36: optional bool shared_with_others
- `aiserver.v1.GrokBotAgentTask`
  - additive +12: repeated string cloud_agent_bc_ids
  - additive +13: optional int32 file_count
  - additive +14: optional string last_message_entry_id
  - additive +15: optional int64 last_message_at_ms
- `aiserver.v1.GrokBotUserRuntimeSettings`
  - additive +16: optional string user_time_zone_override
  - additive +17: optional int32 main_agent_team_id
- `aiserver.v1.SendGrokBotUserMessageRequest`
  - additive +26: repeated string rendered_card_kinds
- `aiserver.v1.UpdateGrokBotUserRuntimeSettingsRequest`
  - additive +13: optional string user_time_zone
  - additive +14: optional string user_time_zone_override

## Enums


**Summary:** 0 breaking change(s) in the used surface.

