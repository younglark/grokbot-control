export const HELP = `gbc — Grok Bot control CLI (programmable App-equivalent control plane)

USAGE:
  gbc [--json|--plain] [--mock] [--allow-writes] [--dry-run] [--base-url URL] [--auth-kind cursor|xai] [--login-mode cli|bot] <noun> <verb> [flags]

EXAMPLES:
  gbc --mock --json bot create --name demo --description "test"
  gbc --mock --json bot list
  gbc --mock --json bot get --agent-id <id>
  gbc --mock --json --allow-writes --dry-run bot delete --agent-id <id> --confirm=<id>
  gbc --mock --json --allow-writes message send --agent-id <id> --session-id <sid> --text "hi"
  gbc --mock --json message status --agent-id <id> --session-id <sid> --message-id <mid>
  gbc --mock --json message history --agent-id <id> [--limit 50] [--offset 0]
  gbc --mock --json session list --agent-id <id> [--limit 50] [--offset 0]
  gbc --mock --json bot status --agent-id <id>
  gbc --mock --json computer state
  gbc --mock --json --allow-writes computer reset --confirm=RESET_COMPUTER
  gbc --json --allow-writes computer reset --confirm=RESET_COMPUTER --wait --timeout 600
  gbc --mock --json --allow-writes sidebar create --name Work
  gbc --mock --json --allow-writes sidebar move --agent-id <id> --section-id <sid>
  gbc --mock --json auth whoami
  gbc --json auth login-begin            # prints authorization_url; open it in a browser
  gbc --json auth login-begin --login-mode bot  # optional App-style URL (sand + supportsSelectedTeamLogin)
  gbc --json auth complete --timeout 300 # polls until signed in (exit 8 auth_pending on timeout)
  gbc --json auth login --timeout 300    # begin+complete; URL as stderr {"event":"open_browser"}
  gbc --json auth login --login-mode bot --timeout 300
  gbc --json auth whoami
  gbc --json auth poll
  gbc --json auth cancel
  gbc --json auth refresh [--force]
  gbc --json auth logout

SYNC (file-first snapshots; no SQLite):
  gbc sync pull --agent-id <id> [--session-id <sid>] --dir /absolute/private/root \\
    --account-id <stable-id> --team-id <stable-team-id|none> --ack-unverified-scope
  gbc sync status --dir /absolute/private/root [--agent-id <id>] [--session-id <sid>]
  gbc sync render --dir /absolute/private/root [--agent-id <id>] [--session-id <sid>]
  gbc sync attachments --dir /absolute/private/root [--agent-id <id>] [--session-id <sid>] [--path <remote>]
  pull bounds: --page-size 100 --max-pages 100 --max-bytes 33554432 --timeout-ms 30000 (defaults)
  body hydration: --hydrate off|missing (default off); inline first, exact omitted re-list, store blob reads.
  hydration bounds: --max-hydrate-requests 32 --hydrate-max-bytes 8388608 --hydrate-max-body-bytes 4194304
  Hard caps: 256 extra RPCs / 64MiB aggregate / 4MiB body; share pull byte/time budget. Partial -> exit 9.
  attachments bounds: --max-file-bytes 33554432 --max-bytes 67108864 --timeout-ms 30000
  --dry-run pull/render/attachments: no RPC or files. --all is not supported in v1.
  attachments also requires --account-id/--team-id/--ack-unverified-scope.
  CLI pull/render/attachments authorize local writes; --allow-writes is NOT required.
  Identity is operator-asserted, NOT verified by auth. Use stable IDs, never email/token hash.
  Existing roots must be private 0700; files 0600. status/render are local and need no login.
  Raw bytes/base64 preserved. render exposes known JSON message/text/notice/tool-summary shapes.
  Raw observed envelopes stay unchanged; recovered bodies carry version-bound provenance/local content hash.
  Unknown cards/unrecovered bodies remain placeholders; no decryption. JSONL/MD grep works offline.
  Line coverage and body coverage are separate; completeness/current membership always unknown. No Watch/deletion.
  attachments: on-demand ResolveGrokBotAttachmentReads for synced user-attachment and send-message attachment App store aliases only.
  MCP: configure GBT_SYNC_ROOT; sync_status is local. sync_pull/render/attachments require independent
  GBT_SYNC_ALLOW_LOCAL_WRITES=1 plus GBT_SYNC_ACCOUNT_ID, GBT_SYNC_TEAM_ID,
  GBT_SYNC_ACK_UNVERIFIED_SCOPE=1 for pull. READONLY excludes sync mutators. No archive path tool argument.
  Head refresh/backfill alternate; retained observations, NOT a current mirror.

NOTES:
  - Default transport is live Connect to --base-url (requires auth). Use --mock only for explicit simulation.
  - Live auth/RPC against production is NOT verified in this build's automated tests.
  - Remote writes require --allow-writes (or GBT_ALLOW_WRITES=1). --dry-run is pure (no RPC).
  - bot delete / sidebar delete / interrupt require --confirm=<resource-id> (exact match).
  - computer reset requires --confirm=RESET_COMPUTER and --allow-writes. It recreates the
    shared computer with preserve_data=false and cannot be canceled after it starts.
    --hard calls ForceRecreateSandBox instead of RecreateSandBox.
  - computer reset --wait follows WatchSandBoxMigration phases (backing-up, creating, moving,
    cleaning-up, wiping, done/failed) and stops waiting at --timeout (1..3600s, default 600).
    SIGINT stops waiting only; the reset may continue. No percentage is reported.
  - Output: success stdout is always the ResultEnvelope (schema_version, ok, data, …),
    on both TTY and pipes. --json selects compact JSON (recommended for agents).
    Without --json, a TTY pretty-prints the same envelope; a pipe stays compact.
    --plain prints only the data object (the old TTY-only shape). Do not pass both
    --json and --plain. Errors are always compact envelope JSON on stderr.
  - Unknown flags exit 2 with a close-name hint. Sync already rejected unknown flags.
  - Value flags: "--flag value" or "--flag=value". A missing value (or a next token starting
    with "--") is a usage error (exit 2); use --text=--literal for values starting with "-".
  - --limit must be an integer 1..1000 (default 50) on bot list, message history,
    session list, and sidebar list. --offset is a 0-based resume from the next field.
    Truncation is marked with truncated, next, and hint. Invalid values exit 2.
  - Write errors that cannot rule out a side effect (unavailable/internal/deadline/transport)
    exit 10 (unknown, retryable=false): reconcile before retrying.
  - Sidebar writes are read back; a semantic mismatch exits 10 with code sidebar_unverified.
  - GBT_TRUST_BACKEND / --trust-backend: only the exact value "1" trusts a custom --base-url.
  - Auth: independent Cursor browser login (static-RE protocol, not official API). Default login
    mode is cli (redirectTarget=cli, no team-login param; live-verified 2026-11-07). Optional
    --login-mode=bot or GBT_LOGIN_MODE=bot uses the App URL shape (redirectTarget=sand and
    supportsSelectedTeamLogin=true). This does not change the default, does not read official App
    credentials or keychain, and does not invent a team id or send x-cursor-team-id / App headers.
    Bot-mode login poll completion was live-verified 2026-11-11 (Cursor token, api2).
    Selected-team binding and refresh after this mode are not live-verified.
    A --login-mode flag overrides GBT_LOGIN_MODE; two conflicting flags exit 2.
    GBT_LOGIN_REDIRECT_TARGET still overrides only the redirectTarget token and stays compatible
    with old configs (e.g. sand without the team-login param). Verifier only in a 0600 pending
    file (15 min); credentials in $GBT_CREDENTIALS_DIR (default ~/.gbc, 0600). Tokens and
    verifier are never printed. xai kind: unsupported. Refresh needs GBT_OAUTH_CLIENT_ID or a
    login-persisted client_id binding (never hardcoded / never guessed from JWT). auth refresh
    without --force may report already_fresh (no network); --force always attempts refresh.
    whoami/status stay offline. RPC 401 updates creds for next request; write RPCs are never auto-
    replayed; whitelisted read-only unary may refresh+retry once. logout/login share the credential
    lock with refresh. Not logged in / pre-RPC refresh failure -> structured auth/retryable error with rpc_dispatched=false.
  - Native auth lock: fs-native-extensions@1.5.3, Node20+, Linux/macOS/Windows prebuilds.
    Missing binding fails closed: npm ci; see https://github.com/younglark/grokbot-control/blob/main/docs/control-plane/auth-lock.md. Local filesystem only; Windows
    ACL privacy requires operator verification. Stop ALL old MCPs before upgrading (lock namespaces differ).
    Wait deadline 30s, refresh HTTP <=20s; wait cancellation never abandons an acquired exchange.
  - MCP cancel ≠ Interrupt. Disconnect does not interrupt runs.
  - Room commands are not mixed into sidebar.

EXIT CODES:
  0 success | 2 usage | 4 auth | 5 not_found | 6 conflict | 7 denied
  8 retryable | 9 known_failure | 10 unknown outcome | 1 other

MCP:
  gbc-mcp                 # stdio; default tool list is read-only + auth
  gbc-mcp --allow-writes  # or GBT_ALLOW_WRITES=1: register write tools
  GBT_MCP_READONLY=1      # stricter: hide auth mutators as well; wins over allow-writes
`;
