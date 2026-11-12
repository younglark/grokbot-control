import path from "node:path";
import { GbcError } from "../errors.js";
import { z } from "zod";
import { LIMIT_DEFAULT, LIMIT_MAX } from "../ops/limits.js";
const limitSchema = z
    .number()
    .int()
    .positive()
    .max(LIMIT_MAX)
    .optional()
    .describe(`Max items to return (1..${LIMIT_MAX}, default ${LIMIT_DEFAULT})`);
const offsetSchema = z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("0-based offset into the client-capped list; use next from a truncated page");
function input(shape) {
    return z.object(shape).strict();
}
export function toolAnnotations(t) {
    const closedWorld = t.name === "auth_whoami" || t.name === "sync_status";
    if (t.authTool) {
        return {
            readOnlyHint: false,
            destructiveHint: t.name === "auth_logout",
            idempotentHint: false,
            openWorldHint: !closedWorld,
        };
    }
    if (t.readOnly) {
        return { readOnlyHint: true, openWorldHint: !closedWorld };
    }
    return {
        readOnlyHint: false,
        destructiveHint: t.name.includes("delete") ||
            t.name === "reset_computer" ||
            t.name === "interrupt_run",
        openWorldHint: true,
    };
}
const agentId = z.string().min(1);
const ifExistsSchema = z
    .enum(["reuse"])
    .optional()
    .describe("reuse: return the single existing match instead of creating (omit to always create)");
const writeFlags = {
    dry_run: z.boolean().optional(),
    allow_writes: z.boolean().optional(),
};
export function buildTools(opts) {
    const all = [
        {
            name: "list_bots",
            description: "List Grok Bot agents (ListGrokBotAgents)",
            readOnly: true,
            inputSchema: input({ limit: limitSchema, offset: offsetSchema }),
            handler: (p, a) => p.bot.list({ limit: a.limit, offset: a.offset }),
        },
        {
            name: "get_bot",
            description: "Get one bot by filtering ListGrokBotAgents (no Get RPC)",
            readOnly: true,
            inputSchema: input({ agent_id: agentId }),
            handler: (p, a) => p.bot.get(String(a.agent_id)),
        },
        {
            name: "create_bot",
            description: "Create temporal harness bot (CreateGrokBotTemporalAgent), then read it back from ListGrokBotAgents. Result has requested{name,title}, observed{name,title}, renamed_by_server; use observed.name. The server has been observed to merge title into name and clear title (not guaranteed). Read-back failure returns code create_unverified, outcome unknown, with error.details.agent_id. Omitted title is sent as \"\" (App behaviour). dry_run cannot detect a server rename. if_exists=\"reuse\": list first and reuse one bot matching agent_id, name, or \"<name> · <title>\" (existing:true, no create); several matches -> ambiguous_match; truncated/failed list -> lookup_incomplete (outcome unknown), nothing created.",
            inputSchema: input({
                name: z.string().min(1),
                description: z.string().optional(),
                title: z.string().optional(),
                agent_id: z.string().optional(),
                language: z.string().optional(),
                kickstart: z.boolean().optional(),
                if_exists: ifExistsSchema,
                ...writeFlags,
            }),
            handler: (p, a) => p.bot.create({
                name: String(a.name),
                description: a.description,
                title: a.title,
                agentId: a.agent_id,
                language: a.language,
                kickstart: Boolean(a.kickstart),
            }, { dryRun: Boolean(a.dry_run), allowWrite: Boolean(a.allow_writes) }, { ifExists: a.if_exists }),
        },
        {
            name: "update_bot",
            description: "Partial update bot (UpdateGrokBotAgent), then read it back from ListGrokBotAgents. Result has requested (null = not patched), observed, renamed_by_server. Read-back failure returns code update_unverified, outcome unknown.",
            inputSchema: input({
                agent_id: agentId,
                name: z.string().optional(),
                description: z.string().optional(),
                title: z.string().optional(),
                ...writeFlags,
            }),
            handler: (p, a) => p.bot.update(String(a.agent_id), {
                name: a.name,
                description: a.description,
                title: a.title,
            }, { dryRun: Boolean(a.dry_run), allowWrite: Boolean(a.allow_writes) }),
        },
        {
            name: "delete_bot",
            description: "Delete bot; requires confirm=agent_id. Sidebar cleanup unverified.",
            inputSchema: input({
                agent_id: agentId,
                confirm: z.string().min(1),
                ...writeFlags,
            }),
            handler: (p, a) => p.bot.delete(String(a.agent_id), {
                confirm: String(a.confirm),
                dryRun: Boolean(a.dry_run),
                allowWrite: Boolean(a.allow_writes),
            }),
        },
        {
            name: "get_computer_state",
            description: "Get the Grok Bot computer run state (GetSandBoxRunState)",
            readOnly: true,
            inputSchema: input({}),
            handler: (p) => p.computer.state(),
        },
        {
            name: "reset_computer",
            description: "Recreate the shared Grok Bot computer. Destructive and not cancelable after start; requires confirm=RESET_COMPUTER. hard uses ForceRecreateSandBox. wait_seconds follows migration phases for up to 30s.",
            inputSchema: input({
                confirm: z.string().min(1),
                hard: z.boolean().optional(),
                wait_seconds: z.number().int().min(0).max(30).optional(),
                ...writeFlags,
            }),
            handler: (p, a) => {
                const waitSeconds = a.wait_seconds ?? 0;
                return p.computer.reset({
                    confirm: String(a.confirm),
                    hard: Boolean(a.hard),
                    wait: waitSeconds > 0,
                    timeoutSeconds: waitSeconds > 0 ? waitSeconds : undefined,
                    dryRun: Boolean(a.dry_run),
                    allowWrite: Boolean(a.allow_writes),
                });
            },
        },
        {
            name: "wake_computer",
            description: "Wake the hibernated shared Grok Bot computer (non-destructive; not a reset, no confirm word). " +
                "Sends EnsureSandBox with an empty request only when the run state is hibernated; running returns " +
                "already_running with no write. Static inference from the official App, NOT live-verified; waking may " +
                "incur compute charges. dry_run reads state only. wait_seconds (0..30) polls GetSandBoxRunState until " +
                "running; still hibernated or timeout returns wake_unverified with outcome unknown. Never returns tokens or URLs.",
            inputSchema: input({
                wait_seconds: z.number().int().min(0).max(30).optional(),
                ...writeFlags,
            }),
            handler: (p, a) => {
                const waitSeconds = a.wait_seconds ?? 0;
                return p.computer.wake({
                    wait: waitSeconds > 0,
                    timeoutSeconds: waitSeconds > 0 ? waitSeconds : undefined,
                    dryRun: Boolean(a.dry_run),
                    allowWrite: Boolean(a.allow_writes),
                });
            },
        },
        {
            name: "send_message",
            description: "Send user message directly (SendGrokBotUserMessage). No task_id required. Delivery ≠ success. " +
                "Returns delivery/mode as names plus *_code, workflow_id and refusal; session_id is null with " +
                "session_source=default_unreported when omitted. delivery=refused is an error (code refused).",
            inputSchema: input({
                agent_id: agentId,
                session_id: z.string().optional(),
                text: z.string().min(1),
                message_id: z.string().optional(),
                ...writeFlags,
            }),
            handler: (p, a) => p.message.send({
                agentId: String(a.agent_id),
                sessionId: a.session_id || undefined,
                text: String(a.text),
                messageId: a.message_id,
                dryRun: Boolean(a.dry_run),
                allowWrite: Boolean(a.allow_writes),
            }),
        },
        {
            name: "get_send_status",
            description: "Get message send status (delivery path). status is a name (e.g. accepted) plus status_code; " +
                "includes echo_entry_id, rejection_code and accepted_at_ms (null when absent).",
            readOnly: true,
            inputSchema: input({
                agent_id: agentId,
                session_id: z.string().optional(),
                message_id: z.string().min(1),
            }),
            handler: (p, a) => p.message.status({
                agentId: String(a.agent_id),
                sessionId: a.session_id || undefined,
                messageId: String(a.message_id),
            }),
        },
        {
            name: "wait_for_message",
            description: "Wait (up to wait_seconds, max 30, default 0 = check once) for the turn started by send_message to settle. " +
                "Done when ListGrokBotAgentStatuses live.last_turn_settlement.turn_id == message_id (completion_basis turn_settlement, " +
                "outcome success|cancelled|error) — mapping from static analysis of the official App, not live-verified. " +
                "Fallback completion_basis running_transition (send accepted, bot seen running, now idle; outcome unknown). " +
                "Not done yet: ok=true, code pending, data.state=pending — call again with the same message_id and pass back " +
                "observed_running from the previous result. On settle, replies are transcript entries after echo_entry_id " +
                "(2000-char text unless full=true); subagents are reported (has_running_subagents, working_task_ids), not awaited. " +
                "Send status rejected → code message_rejected; not_found → message_not_found.",
            readOnly: true,
            inputSchema: input({
                agent_id: agentId,
                message_id: z.string().min(1),
                session_id: z.string().min(1).optional(),
                wait_seconds: z.number().int().min(0).max(30).optional(),
                observed_running: z.boolean().optional(),
                full: z.boolean().optional(),
            }),
            handler: (p, a) => p.message.wait({
                agentId: String(a.agent_id),
                messageId: String(a.message_id),
                sessionId: a.session_id || undefined,
                timeoutSeconds: a.wait_seconds ?? 0,
                intervalSeconds: 2,
                observedRunning: Boolean(a.observed_running),
                full: Boolean(a.full),
                onTimeout: "pending",
            }),
        },
        {
            name: "list_transcript",
            description: "List transcript entries with decoded text (same decoder as message history / dashboard). " +
                "text is capped at 2000 chars unless full=true; session_id is sent only when given. Nothing is decrypted.",
            readOnly: true,
            inputSchema: input({
                agent_id: agentId,
                session_id: z.string().min(1).optional(),
                limit: limitSchema,
                offset: offsetSchema,
                full: z.boolean().optional(),
            }),
            handler: (p, a) => p.message.history({
                agentId: String(a.agent_id),
                sessionId: a.session_id,
                full: Boolean(a.full),
                limit: a.limit,
                offset: a.offset,
            }),
        },
        {
            name: "list_sessions",
            description: "List agent sessions",
            readOnly: true,
            inputSchema: input({ agent_id: agentId, limit: limitSchema, offset: offsetSchema }),
            handler: (p, a) => p.session.list(String(a.agent_id), {
                limit: a.limit,
                offset: a.offset,
            }),
        },
        {
            name: "get_bot_status",
            description: "Native live progress status",
            readOnly: true,
            inputSchema: input({ agent_id: agentId }),
            handler: (p, a) => p.progress.status([String(a.agent_id)]),
        },
        {
            name: "list_agent_todos",
            description: "Native agent todos (not bridge tasks)",
            readOnly: true,
            inputSchema: input({ agent_id: agentId }),
            handler: (p, a) => p.progress.todos(String(a.agent_id)),
        },
        {
            name: "list_agent_tasks",
            description: "Native agent tasks",
            readOnly: true,
            inputSchema: input({ agent_id: agentId }),
            handler: (p, a) => p.progress.tasks(String(a.agent_id)),
        },
        {
            name: "list_agent_subagents",
            description: "ListGrokBotSubagents",
            readOnly: true,
            inputSchema: input({ agent_id: agentId }),
            handler: (p, a) => p.progress.subagents(String(a.agent_id)),
        },
        {
            name: "interrupt_run",
            description: "InterruptGrokBotAgentRun. MCP request cancel does NOT call this.",
            inputSchema: input({
                agent_id: agentId,
                confirm: z.string().min(1),
                reason: z.string().optional(),
                session_id: z.string().optional(),
                ...writeFlags,
            }),
            handler: (p, a) => p.progress.interrupt(String(a.agent_id), {
                confirm: String(a.confirm),
                reason: a.reason,
                sessionId: a.session_id,
                dryRun: Boolean(a.dry_run),
                allowWrite: Boolean(a.allow_writes),
            }),
        },
        {
            name: "get_sidebar_sections",
            description: "Read SidebarSections from runtime settings",
            readOnly: true,
            inputSchema: input({ limit: limitSchema, offset: offsetSchema }),
            handler: (p, a) => p.sidebar.list({
                limit: a.limit,
                offset: a.offset,
            }),
        },
        {
            name: "create_sidebar_section",
            description: "Create sidebar section (does not delete bots). Result has section_id and existing. if_exists=\"reuse\": reuse the one section with exactly this name (existing:true, no write); several -> ambiguous_match.",
            inputSchema: input({ name: z.string().min(1), if_exists: ifExistsSchema, ...writeFlags }),
            handler: (p, a) => p.sidebar.createSection(String(a.name), {
                dryRun: Boolean(a.dry_run),
                allowWrite: Boolean(a.allow_writes),
            }, { ifExists: a.if_exists }),
        },
        {
            name: "rename_sidebar_section",
            inputSchema: input({
                section_id: z.string().min(1),
                name: z.string().min(1),
                ...writeFlags,
            }),
            description: "Rename sidebar section",
            handler: (p, a) => p.sidebar.renameSection(String(a.section_id), String(a.name), {
                dryRun: Boolean(a.dry_run),
                allowWrite: Boolean(a.allow_writes),
            }),
        },
        {
            name: "delete_sidebar_section",
            description: "Delete sidebar section only — does not delete bots",
            inputSchema: input({
                section_id: z.string().min(1),
                confirm: z.string().min(1),
                ...writeFlags,
            }),
            handler: (p, a) => p.sidebar.deleteSection(String(a.section_id), {
                confirm: String(a.confirm),
                dryRun: Boolean(a.dry_run),
                allowWrite: Boolean(a.allow_writes),
            }),
        },
        {
            name: "move_bot_to_sidebar_section",
            description: "Move bot into a sidebar section, by section_id or a unique exact section_name (pass exactly one). Already only in that section -> skipped:true, no write, position kept.",
            inputSchema: input({
                agent_id: agentId,
                section_id: z.string().min(1).optional(),
                section_name: z.string().min(1).optional(),
                ...writeFlags,
            }),
            handler: (p, a) => p.sidebar.moveBot(String(a.agent_id), {
                sectionId: a.section_id,
                sectionName: a.section_name,
            }, {
                dryRun: Boolean(a.dry_run),
                allowWrite: Boolean(a.allow_writes),
            }),
        },
        {
            name: "auth_whoami",
            description: "Local credential status (no network; never returns tokens)",
            readOnly: true,
            inputSchema: input({}),
            handler: (p) => p.authOps.whoami(),
        },
        {
            name: "auth_login_begin",
            description: "Start independent Cursor browser login. Returns authorization_url for the user to open; verifier stays in a 0600 pending file. Optional login_mode=bot uses the App URL shape (redirectTarget=sand, supportsSelectedTeamLogin=true) without reading official App credentials or inventing a team id. Default is cli.",
            readOnly: true,
            authTool: true,
            inputSchema: input({
                login_mode: z
                    .enum(["cli", "bot"])
                    .optional()
                    .describe("Login URL preset. cli (default) uses redirectTarget=cli. bot uses redirectTarget=sand and supportsSelectedTeamLogin=true. Does not read App secrets or set team headers."),
            }),
            handler: (p, a) => p.authOps.begin({ loginMode: a.login_mode }),
        },
        {
            name: "auth_login_complete",
            description: "Poll the pending login until signed in or timeout (default 60s, max 120s). Returns auth_pending (retryable) if not yet signed in.",
            readOnly: true,
            authTool: true,
            inputSchema: input({
                timeout_seconds: z.number().int().min(1).max(120).optional(),
            }),
            handler: (p, a) => p.authOps.complete(a.timeout_seconds ?? 60),
        },
        {
            name: "auth_login_cancel",
            description: "Discard the pending login (local only)",
            readOnly: true,
            authTool: true,
            inputSchema: input({}),
            handler: (p) => p.authOps.cancel(),
        },
        {
            name: "auth_logout",
            description: "Remove this tool's own local credential (does not revoke server session or touch the App)",
            readOnly: true,
            authTool: true,
            inputSchema: input({}),
            handler: (p) => p.authOps.logout(),
        },
        {
            name: "auth_refresh",
            description: "Refresh local Cursor OAuth credentials (non-secret metadata only). Without force, may report already_fresh with no network call. Auto refresh still happens before RPCs when near expiry. Not exposed under GBT_MCP_READONLY=1.",
            authTool: true,
            inputSchema: input({
                force: z.boolean().optional(),
            }),
            handler: (p, a) => p.authOps.refresh({ force: Boolean(a.force) }),
        },
    ];
    if (opts?.sync) {
        const c = { ...opts.sync }; // startup-only copy: callers cannot choose paths or account scope
        if (!path.isAbsolute(c.root))
            throw new GbcError("invalid_argument", "MCP sync root must be absolute");
        const selectors = {
            agent_id: agentId.optional(),
            session_id: agentId.optional(),
        };
        all.push({
            name: "sync_status",
            description: "Read bounded local archive status; no login/RPC",
            readOnly: true,
            inputSchema: input(selectors),
            handler: (p, a) => p.sync.status({
                dir: c.root,
                agentId: a.agent_id,
                sessionId: a.session_id,
            }),
        });
        if (c.allowLocalWrites && opts?.allowWrites && !opts.readOnly) {
            all.push({
                name: "sync_pull",
                description: "Write a bounded local snapshot to the configured private root. Only remote read RPCs; known JSON entry kinds decoded, unknown bodies opaque, completeness unknown.",
                inputSchema: z
                    .object({
                    agent_id: agentId,
                    session_id: agentId.optional(),
                    dry_run: z.boolean().optional(),
                    page_size: z.number().int().min(1).max(500).optional(),
                    hydrate: z.enum(["off", "missing"]).optional(),
                    max_hydrate_requests: z.number().int().min(1).max(256).optional(),
                    hydrate_max_bytes: z
                        .number()
                        .int()
                        .min(1)
                        .max(64 * 1024 * 1024)
                        .optional(),
                    hydrate_max_body_bytes: z
                        .number()
                        .int()
                        .min(1)
                        .max(4 * 1024 * 1024)
                        .optional(),
                    max_pages: z.number().int().min(1).max(1000).optional(),
                    max_bytes: z
                        .number()
                        .int()
                        .min(1)
                        .max(256 * 1024 * 1024)
                        .optional(),
                    timeout_ms: z.number().int().min(1).max(300000).optional(),
                })
                    .strict(),
                handler: (p, a) => p.sync.pull({
                    dir: c.root,
                    agentId: String(a.agent_id),
                    sessionId: a.session_id,
                    accountId: c.accountId ?? "",
                    teamId: c.teamId ?? "",
                    acknowledgeUnverifiedScope: c.acknowledgeUnverifiedScope === true,
                    dryRun: a.dry_run,
                    pageSize: a.page_size,
                    hydrate: a.hydrate,
                    maxHydrateRequests: a.max_hydrate_requests,
                    hydrateMaxBytes: a.hydrate_max_bytes,
                    hydrateMaxBodyBytes: a.hydrate_max_body_bytes,
                    maxPages: a.max_pages,
                    maxBytes: a.max_bytes,
                    timeoutMs: a.timeout_ms,
                }),
            });
            all.push({
                name: "sync_render",
                description: "Rebuild readable Markdown for verified JSON message/tool-summary shapes locally; unknown bodies opaque, no decryption or RPC",
                inputSchema: z
                    .object({ ...selectors, dry_run: z.boolean().optional() })
                    .strict(),
                handler: (p, a) => p.sync.render({
                    dir: c.root,
                    agentId: a.agent_id,
                    sessionId: a.session_id,
                    dryRun: a.dry_run,
                }),
            });
            all.push({
                name: "sync_attachments",
                description: "On-demand download of synced user-attachment file_path via ResolveGrokBotAttachmentReads + HTTPS GET into the configured private root. Not live verified; signed URLs never stored; not blob_hash hydration.",
                inputSchema: z
                    .object({
                    ...selectors,
                    path: z.string().min(1).max(4096).optional(),
                    dry_run: z.boolean().optional(),
                    max_bytes: z
                        .number()
                        .int()
                        .min(1)
                        .max(256 * 1024 * 1024)
                        .optional(),
                    max_file_bytes: z
                        .number()
                        .int()
                        .min(1)
                        .max(128 * 1024 * 1024)
                        .optional(),
                    timeout_ms: z.number().int().min(1).max(300000).optional(),
                })
                    .strict(),
                handler: (p, a) => p.sync.attachments({
                    dir: c.root,
                    agentId: a.agent_id,
                    sessionId: a.session_id,
                    path: a.path,
                    accountId: c.accountId ?? "",
                    teamId: c.teamId ?? "",
                    acknowledgeUnverifiedScope: c.acknowledgeUnverifiedScope === true,
                    dryRun: a.dry_run,
                    maxBytes: a.max_bytes,
                    maxFileBytes: a.max_file_bytes,
                    timeoutMs: a.timeout_ms,
                }),
            });
        }
    }
    if (opts?.readOnly)
        return all.filter((t) => t.readOnly && !t.authTool);
    if (!opts?.allowWrites)
        return all.filter((t) => t.readOnly || t.authTool);
    return all;
}
