import path from "node:path";
import { GbcError } from "../errors.js";
import { z } from "zod";
import type { ControlPlane } from "../ops/plane.js";
import type { ResultEnvelope } from "../dto/result.js";
import { LIMIT_MAX } from "../ops/limits.js";

const limitSchema = z.number().int().positive().max(LIMIT_MAX).optional();

export type ToolDef = {
  name: string;
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: z.ZodObject<any>;
  /** Does not mutate Grok Bot server state (safe in read-only toolsets). */
  readOnly?: boolean;
  /** Local auth-state tool (changes only this tool's own credential files). */
  authTool?: boolean;
  handler: (plane: ControlPlane, args: Record<string, unknown>) => Promise<ResultEnvelope>;
};

const agentId = z.string().min(1);
const writeFlags = {
  dry_run: z.boolean().optional(),
  allow_writes: z.boolean().optional(),
};

export type SyncToolConfig = { root: string; allowLocalWrites?: boolean; accountId?: string; teamId?: string; acknowledgeUnverifiedScope?: boolean };
export function buildTools(opts?: { readOnly?: boolean; sync?: SyncToolConfig }): ToolDef[] {
  const all: ToolDef[] = [
    {
      name: "list_bots",
      description: "List Grok Bot agents (ListGrokBotAgents)",
      readOnly: true,
      inputSchema: z.object({ limit: limitSchema }),
      handler: (p, a) => p.bot.list({ limit: a.limit as number | undefined }),
    },
    {
      name: "get_bot",
      description: "Get one bot by filtering ListGrokBotAgents (no Get RPC)",
      readOnly: true,
      inputSchema: z.object({ agent_id: agentId }),
      handler: (p, a) => p.bot.get(String(a.agent_id)),
    },
    {
      name: "create_bot",
      description: "Create temporal harness bot (CreateGrokBotTemporalAgent)",
      inputSchema: z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        title: z.string().optional(),
        agent_id: z.string().optional(),
        language: z.string().optional(),
        kickstart: z.boolean().optional(),
        ...writeFlags,
      }),
      handler: (p, a) =>
        p.bot.create(
          {
            name: String(a.name),
            description: a.description as string | undefined,
            title: a.title as string | undefined,
            agentId: a.agent_id as string | undefined,
            language: a.language as string | undefined,
            kickstart: Boolean(a.kickstart),
          },
          { dryRun: Boolean(a.dry_run), allowWrite: Boolean(a.allow_writes) },
        ),
    },
    {
      name: "update_bot",
      description: "Partial update bot (UpdateGrokBotAgent)",
      inputSchema: z.object({
        agent_id: agentId,
        name: z.string().optional(),
        description: z.string().optional(),
        title: z.string().optional(),
        ...writeFlags,
      }),
      handler: (p, a) =>
        p.bot.update(
          String(a.agent_id),
          {
            name: a.name as string | undefined,
            description: a.description as string | undefined,
            title: a.title as string | undefined,
          },
          { dryRun: Boolean(a.dry_run), allowWrite: Boolean(a.allow_writes) },
        ),
    },
    {
      name: "delete_bot",
      description: "Delete bot; requires confirm=agent_id. Sidebar cleanup unverified.",
      inputSchema: z.object({
        agent_id: agentId,
        confirm: z.string().min(1),
        ...writeFlags,
      }),
      handler: (p, a) =>
        p.bot.delete(String(a.agent_id), {
          confirm: String(a.confirm),
          dryRun: Boolean(a.dry_run),
          allowWrite: Boolean(a.allow_writes),
        }),
    },
    {
      name: "send_message",
      description: "Send user message directly (SendGrokBotUserMessage). No task_id required. Delivery ≠ success.",
      inputSchema: z.object({
        agent_id: agentId,
        session_id: z.string().min(1),
        text: z.string().min(1),
        message_id: z.string().optional(),
        ...writeFlags,
      }),
      handler: (p, a) =>
        p.message.send({
          agentId: String(a.agent_id),
          sessionId: String(a.session_id),
          text: String(a.text),
          messageId: a.message_id as string | undefined,
          dryRun: Boolean(a.dry_run),
          allowWrite: Boolean(a.allow_writes),
        }),
    },
    {
      name: "get_send_status",
      description: "Get message send status (delivery path)",
      readOnly: true,
      inputSchema: z.object({
        agent_id: agentId,
        session_id: z.string().min(1),
        message_id: z.string().min(1),
      }),
      handler: (p, a) =>
        p.message.status({
          agentId: String(a.agent_id),
          sessionId: String(a.session_id),
          messageId: String(a.message_id),
        }),
    },
    {
      name: "list_transcript",
      description: "List transcript entries; ciphertext not decrypted",
      readOnly: true,
      inputSchema: z.object({ agent_id: agentId, limit: limitSchema }),
      handler: (p, a) => p.message.history({ agentId: String(a.agent_id), limit: a.limit as number | undefined }),
    },
    {
      name: "list_sessions",
      description: "List agent sessions",
      readOnly: true,
      inputSchema: z.object({ agent_id: agentId }),
      handler: (p, a) => p.session.list(String(a.agent_id)),
    },
    {
      name: "get_bot_status",
      description: "Native live progress status",
      readOnly: true,
      inputSchema: z.object({ agent_id: agentId }),
      handler: (p, a) => p.progress.status([String(a.agent_id)]),
    },
    {
      name: "list_agent_todos",
      description: "Native agent todos (not bridge tasks)",
      readOnly: true,
      inputSchema: z.object({ agent_id: agentId }),
      handler: (p, a) => p.progress.todos(String(a.agent_id)),
    },
    {
      name: "list_agent_tasks",
      description: "Native agent tasks",
      readOnly: true,
      inputSchema: z.object({ agent_id: agentId }),
      handler: (p, a) => p.progress.tasks(String(a.agent_id)),
    },
    {
      name: "list_agent_subagents",
      description: "ListGrokBotSubagents",
      readOnly: true,
      inputSchema: z.object({ agent_id: agentId }),
      handler: (p, a) => p.progress.subagents(String(a.agent_id)),
    },
    {
      name: "interrupt_run",
      description: "InterruptGrokBotAgentRun. MCP request cancel does NOT call this.",
      inputSchema: z.object({
        agent_id: agentId,
        confirm: z.string().min(1),
        reason: z.string().optional(),
        session_id: z.string().optional(),
        ...writeFlags,
      }),
      handler: (p, a) =>
        p.progress.interrupt(String(a.agent_id), {
          confirm: String(a.confirm),
          reason: a.reason as string | undefined,
          sessionId: a.session_id as string | undefined,
          dryRun: Boolean(a.dry_run),
          allowWrite: Boolean(a.allow_writes),
        }),
    },
    {
      name: "get_sidebar_sections",
      description: "Read SidebarSections from runtime settings",
      readOnly: true,
      inputSchema: z.object({}),
      handler: (p) => p.sidebar.list(),
    },
    {
      name: "create_sidebar_section",
      description: "Create sidebar section (does not delete bots)",
      inputSchema: z.object({ name: z.string().min(1), ...writeFlags }),
      handler: (p, a) =>
        p.sidebar.createSection(String(a.name), {
          dryRun: Boolean(a.dry_run),
          allowWrite: Boolean(a.allow_writes),
        }),
    },
    {
      name: "rename_sidebar_section",
      inputSchema: z.object({ section_id: z.string().min(1), name: z.string().min(1), ...writeFlags }),
      description: "Rename sidebar section",
      handler: (p, a) =>
        p.sidebar.renameSection(String(a.section_id), String(a.name), {
          dryRun: Boolean(a.dry_run),
          allowWrite: Boolean(a.allow_writes),
        }),
    },
    {
      name: "delete_sidebar_section",
      description: "Delete sidebar section only — does not delete bots",
      inputSchema: z.object({
        section_id: z.string().min(1),
        confirm: z.string().min(1),
        ...writeFlags,
      }),
      handler: (p, a) =>
        p.sidebar.deleteSection(String(a.section_id), {
          confirm: String(a.confirm),
          dryRun: Boolean(a.dry_run),
          allowWrite: Boolean(a.allow_writes),
        }),
    },
    {
      name: "move_bot_to_sidebar_section",
      description: "Move bot into a sidebar section",
      inputSchema: z.object({
        agent_id: agentId,
        section_id: z.string().min(1),
        ...writeFlags,
      }),
      handler: (p, a) =>
        p.sidebar.moveBot(String(a.agent_id), String(a.section_id), {
          dryRun: Boolean(a.dry_run),
          allowWrite: Boolean(a.allow_writes),
        }),
    },
    {
      name: "auth_whoami",
      description: "Local credential status (no network; never returns tokens)",
      readOnly: true,
      inputSchema: z.object({}),
      handler: (p) => p.authOps.whoami(),
    },
    {
      name: "auth_login_begin",
      description:
        "Start independent Cursor browser login. Returns authorization_url for the user to open; verifier stays in a 0600 pending file.",
      readOnly: true,
      authTool: true,
      inputSchema: z.object({}),
      handler: (p) => p.authOps.begin(),
    },
    {
      name: "auth_login_complete",
      description:
        "Poll the pending login until signed in or timeout (default 60s, max 120s). Returns auth_pending (retryable) if not yet signed in.",
      readOnly: true,
      authTool: true,
      inputSchema: z.object({ timeout_seconds: z.number().int().min(1).max(120).optional() }),
      handler: (p, a) => p.authOps.complete((a.timeout_seconds as number | undefined) ?? 60),
    },
    {
      name: "auth_login_cancel",
      description: "Discard the pending login (local only)",
      readOnly: true,
      authTool: true,
      inputSchema: z.object({}),
      handler: (p) => p.authOps.cancel(),
    },
    {
      name: "auth_logout",
      description: "Remove this tool's own local credential (does not revoke server session or touch the App)",
      readOnly: true,
      authTool: true,
      inputSchema: z.object({}),
      handler: (p) => p.authOps.logout(),
    },
  ];
  if (opts?.sync) {
    const c = { ...opts.sync }; // startup-only copy: callers cannot choose paths or account scope
    if (!path.isAbsolute(c.root)) throw new GbcError("invalid_argument", "MCP sync root must be absolute");
    const selectors = { agent_id: agentId.optional(), session_id: agentId.optional() };
    all.push({ name: "sync_status", description: "Read bounded local archive status; no login/RPC", readOnly: true,
      inputSchema: z.object(selectors).strict(), handler: (p,a) => p.sync.status({ dir: c.root, agentId: a.agent_id as string | undefined, sessionId: a.session_id as string | undefined }) });
    if (c.allowLocalWrites && !opts.readOnly) {
      all.push({ name: "sync_pull", description: "Write a bounded local snapshot to the configured private root. Only remote read RPCs; known JSON entry kinds decoded, unknown bodies opaque, completeness unknown.",
        inputSchema: z.object({ agent_id: agentId, session_id: agentId.optional(), dry_run: z.boolean().optional(), max_pages: z.number().int().min(1).max(1000).optional(), max_bytes: z.number().int().min(1).max(256*1024*1024).optional(), timeout_ms: z.number().int().min(1).max(300000).optional() }).strict(),
        handler: (p,a) => p.sync.pull({ dir: c.root, agentId: String(a.agent_id), sessionId: a.session_id as string | undefined, accountId: c.accountId ?? "", teamId: c.teamId ?? "", acknowledgeUnverifiedScope: c.acknowledgeUnverifiedScope === true, dryRun: a.dry_run as boolean | undefined, maxPages: a.max_pages as number | undefined, maxBytes: a.max_bytes as number | undefined, timeoutMs: a.timeout_ms as number | undefined }) });
      all.push({ name: "sync_render", description: "Rebuild readable Markdown for verified JSON message/tool-summary shapes locally; unknown bodies opaque, no decryption or RPC",
        inputSchema: z.object({ ...selectors, dry_run: z.boolean().optional() }).strict(),
        handler: (p,a) => p.sync.render({ dir: c.root, agentId: a.agent_id as string | undefined, sessionId: a.session_id as string | undefined, dryRun: a.dry_run as boolean | undefined }) });
      all.push({ name: "sync_attachments", description: "On-demand download of synced user-attachment file_path via ResolveGrokBotAttachmentReads + HTTPS GET into the configured private root. Not live verified; signed URLs never stored; not blob_hash hydration.",
        inputSchema: z.object({ ...selectors, path: z.string().min(1).max(1024).optional(), dry_run: z.boolean().optional(), max_bytes: z.number().int().min(1).max(256*1024*1024).optional(), max_file_bytes: z.number().int().min(1).max(128*1024*1024).optional(), timeout_ms: z.number().int().min(1).max(300000).optional() }).strict(),
        handler: (p,a) => p.sync.attachments({ dir: c.root, agentId: a.agent_id as string | undefined, sessionId: a.session_id as string | undefined, path: a.path as string | undefined, dryRun: a.dry_run as boolean | undefined, maxBytes: a.max_bytes as number | undefined, maxFileBytes: a.max_file_bytes as number | undefined, timeoutMs: a.timeout_ms as number | undefined }) });
    }
  }
  if (opts?.readOnly) return all.filter((t) => t.readOnly);
  return all;
}
