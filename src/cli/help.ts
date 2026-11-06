export const HELP = `gbc — Grok Bot control CLI (programmable App-equivalent control plane)

USAGE:
  gbc [--json] [--mock] [--allow-writes] [--dry-run] [--base-url URL] [--auth-kind cursor|xai] <noun> <verb> [flags]

EXAMPLES:
  gbc --mock --json bot create --name demo --description "test"
  gbc --mock --json bot list
  gbc --mock --json bot get --agent-id <id>
  gbc --mock --json --allow-writes --dry-run bot delete --agent-id <id> --confirm=<id>
  gbc --mock --json --allow-writes message send --agent-id <id> --session-id <sid> --text "hi"
  gbc --mock --json message status --agent-id <id> --session-id <sid> --message-id <mid>
  gbc --mock --json message history --agent-id <id>
  gbc --mock --json session list --agent-id <id>
  gbc --mock --json bot status --agent-id <id>
  gbc --mock --json --allow-writes sidebar create --name Work
  gbc --mock --json --allow-writes sidebar move --agent-id <id> --section-id <sid>
  gbc --mock --json auth whoami

NOTES:
  - Default transport is live Connect to --base-url (requires auth). Use --mock only for explicit simulation.
  - Live auth/RPC against production is NOT verified in this build's automated tests.
  - Writes require --allow-writes (or GBT_ALLOW_WRITES=1). --dry-run is pure (no RPC).
  - delete/interrupt require --confirm=<resource-id>.
  - MCP cancel ≠ Interrupt. Disconnect does not interrupt runs.
  - Room commands are not mixed into sidebar.

EXIT CODES:
  0 success | 2 usage | 4 auth | 5 not_found | 6 conflict | 7 denied
  8 retryable | 9 known_failure | 10 unknown outcome | 1 other

MCP:
  gbc-mcp   # stdio MCP server (same SDK ops)
`;
