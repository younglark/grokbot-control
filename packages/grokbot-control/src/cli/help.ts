export const HELP = `gbc — Grok Bot control CLI (programmable App-equivalent control plane)

USAGE:
  gbc [--json|--plain] [--mock] [--allow-writes] [--dry-run] [--base-url URL] [--auth-kind cursor|xai] [--login-mode cli|bot] <noun> <verb> [flags]
  gbc dashboard [--port 8787] [--host 127.0.0.1] [--no-open]

EXAMPLES:
  gbc --mock --json bot create --name demo --description "test"
  gbc --json --allow-writes bot create --name Showrunner --title 幕僚长 --description-file ./showrunner.md
  gbc --json --allow-writes bot update --agent-id <id> --description-file ./showrunner.md
  gbc --mock --json bot list
  gbc --mock --json bot get --agent-id <id>
  gbc --mock --json --allow-writes --dry-run bot delete --agent-id <id> --confirm=<id>
  gbc --mock --json --allow-writes message send --agent-id <id> --session-id <sid> --text "hi"
  gbc --mock --json message status --agent-id <id> --session-id <sid> --message-id <mid>
  gbc --mock --json message history --agent-id <id> [--session-id <sid>] [--limit 50] [--offset 0] [--full]
  gbc --mock --json session list --agent-id <id> [--limit 50] [--offset 0]
  gbc --mock --json bot status --agent-id <id>
  gbc --mock --json computer state
  gbc --json --dry-run computer wake        # reads run state only; no write
  gbc --json --allow-writes computer wake --wait --timeout 120
  gbc --mock --json account cleanup --dry-run
  gbc --mock --json --allow-writes account cleanup --confirm=ACCOUNT_CLEANUP --plan=<fingerprint>
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

DASHBOARD (local read-only Bot monitor; not the official DashboardService):
  gbc dashboard
  gbc dashboard start [--port 8787] [--host 127.0.0.1] [--no-open]
  Prints a loopback URL (http://127.0.0.1:<port>/s/<random>/) and opens a browser.
  --json: one ResultEnvelope with data.url / data.bind / data.opened, then stays up (no stdout heartbeat).
  --plain: print only the URL. --no-open prints without opening a browser.
  Default bind is 127.0.0.1; v1 refuses a non-loopback --host. --port 0 is allowed;
  if the requested port is taken, another is chosen and the actual URL is printed.
  Unauthenticated: the server still starts; the page asks you to run \`gbc auth login\` in the
  terminal and refresh. The page never collects credentials. Ctrl+C / SIGTERM exit 0;
  remote Bots are not interrupted. Near-realtime is local poll + SSE, not a Watch stream.
  No MCP dashboard tools in v1. Official DashboardService write RPCs are never exposed.

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
  - account cleanup deletes personal bots this account owns, then recreates the shared
    computer with the same preserve_data=false reset as \`computer reset\`. It is not a full
    account reset: it does not cancel a subscription, delete the account, or claim to
    clear sessions, connectors, Library, skills/routines, or all cloud data. Side effects
    are not live-verified. Preview first: \`gbc account cleanup --dry-run\` lists targets,
    skips (shared/team/others/unknown ownership are never guessed or deleted), counts,
    data-loss warnings, and a plan fingerprint. A truncated ListGrokBotAgents response
    is refused before any write. Real execution needs --allow-writes and
    --confirm=ACCOUNT_CLEANUP --plan=<fingerprint> from that exact preview. If the
    current list no longer matches the plan, no writes are sent. Deletes are serial and
    reported one by one. Any failure, permission error, or unknown outcome stops the
    flow; computer reset is not started and unknown writes are not retried. After
    successful deletes a read-only re-list must show no planned residual and no new
    owned targets, or reset is skipped. Zero owned bots is valid: matching empty plan,
    no deletes, then reset. --hard/--wait/--timeout are forwarded to the existing
    computer reset and keep its semantics (SIGINT stops waiting only). The flow is not
    a transaction; already-deleted bots cannot be undone. Existing \`bot delete\` and
    \`computer reset\` stay unchanged. No dashboard or MCP entry for this command.
  - computer wake (non-destructive; separate from reset, no confirm word) sends one
    EnsureSandBox with an empty request (wake/supports_asleep_box unset, no extra headers)
    when \`computer state\` is hibernated. STATIC INFERENCE from the official App, NOT
    live-verified; waking may incur compute charges. Requires --allow-writes (or
    GBT_ALLOW_WRITES=1). running -> already_running (no write); starting -> no write;
    absent/unspecified -> refused (exit 7, wake never provisions). --dry-run reads
    GetSandBoxRunState only and reports the planned action. After the write, the state
    is read back once; --wait polls GetSandBoxRunState until running (--timeout 1..3600s,
    default 120). Still hibernated / timeout / failed read-back -> wake_unverified,
    outcome unknown, exit 10. Output is whitelisted (run state names+codes,
    image_update_available, image); tokens and URLs from EnsureSandBoxResponse are never
    printed. It never upgrades the image, resets, or calls EnsureSandBoxWindow.
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
  - message send/status print enum names (lower snake) with the number in *_code:
    delivery/delivery_code, mode/mode_code, status/status_code; a value the schema does not
    define prints "unknown" plus its code. send also returns workflow_id and refusal (null when
    absent). Without --session-id, session_id is null and session_source is
    "default_unreported" (the RPC does not return the session it used). delivery=refused is a
    failure: ok=false, code refused, exit 7, data still carries refusal and workflow_id.
  - message history decodes bodies like the dashboard transcript: preview (200 chars) plus text
    (capped at 2000 chars; --full for all of it). Omitted/opaque bodies stay placeholders;
    nothing is decrypted. --session-id is sent to the server only when given.
  - Write errors that cannot rule out a side effect (unavailable/internal/deadline/transport)
    exit 10 (unknown, retryable=false): reconcile before retrying.
  - Sidebar writes are read back; a semantic mismatch exits 10 with code sidebar_unverified.
  - bot create / bot update read the bot back from ListGrokBotAgents (up to 3 reads, short
    backoff, ~3s budget; retried only while the agent is absent). data carries
    requested{name,title}, observed{name,title}, renamed_by_server and changed_fields; data.bot
    is the read-back. The server has been observed to merge --title into the display name
    ("Showrunner · 幕僚长") and clear title (issue #3; not guaranteed for every account, no
    client-side evidence). Use observed.name, not the requested name. If the read-back fails,
    is truncated, or never finds the agent: exit 10, code create_unverified/update_unverified,
    outcome unknown; error.details.agent_id is kept for reconciliation. --dry-run sends no RPC
    and cannot reveal such a rename. Without --title, create sends title "" (as the App does).
  - --description-file <path> (bot create/update) reads UTF-8 verbatim like --text-file; it
    is exclusive with --description (exit 2). "-" is a path, not stdin.
  - Do not re-print --json output with echo: JSON strings keep newlines as \\n escapes and some
    shells' echo turns them into raw newlines (invalid JSON). Pipe stdout directly, or use
    raw=$(gbc --json ...); printf '%s' "$raw" | jq .
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
  0 success | 2 usage | 4 auth | 5 not_found | 6 conflict | 7 denied/refused
  8 retryable | 9 known_failure | 10 unknown outcome | 1 other

MCP:
  gbc-mcp                 # stdio; default tool list is read-only + auth
  gbc-mcp --allow-writes  # or GBT_ALLOW_WRITES=1: register write tools
  GBT_MCP_READONLY=1      # stricter: hide auth mutators as well; wins over allow-writes
`;
