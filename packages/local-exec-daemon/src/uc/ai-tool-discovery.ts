/** discover-ai-tool — static port of local-exec-daemon 0.79.3 VJe and helpers (daemon.formatted.cjs, D:).
 *
 * D:97060–97086 sources/limits/Fpe/pJe; D:97087–97117 bp/mJe/hJe sanitizer; D:97545–97578 zod schemas (zod v4 in the
 * original bundle; here `zod/v4` from the pinned zod package); D:97579–97842 VJe/qJe/_Ht/KJe/AHt/ZJe/jpe/QJe/rqe.
 * Pure local filesystem reads under the Claude Code / Codex config roots. No network, no writes, no extra limits.
 */
import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod/v4";

/** D:QP 97060 */
export const AI_TOOL_SOURCES = ["claude_code", "codex"] as const;
export type AiToolSource = (typeof AI_TOOL_SOURCES)[number];
/** D:fJe 97061 */
export function isAiToolSource(t: unknown): t is AiToolSource { return AI_TOOL_SOURCES.some(e => e === t); }
const LABEL: Record<AiToolSource, string> = { claude_code: "Claude Code", codex: "Codex" }; // D:Cjt
const MAX_ITEMS = 40;             // D:$pe
const MAX_TITLE = 160;            // D:XP
const HISTORY_TAIL = 256 * 1024;  // D:pHt
const MAX_SESSION_FILES = 500;    // D:FJe
const MAX_CONFIG_ITEMS = 24;      // D:mHt
const MAX_DIR_ENTRIES = 200;      // D:hHt
const SLASH_COMMAND = /^\/[A-Za-z][\w:-]*(?:\s|$)/;          // D:gHt
const PASTED = /\[(?:Pasted text|Image) #\d+[^\]]*\]/g;     // D:SHt

export type AiToolItem = { kind: "session" | "mcp_server" | "skill" | "plugin"; title: string; excerpt?: string; occurredAtMs?: number };
export type AiToolDiscovery = { source: AiToolSource; found: boolean; sessionCount: number; lastActiveAtMs?: number; items: AiToolItem[] };
export type AiToolConfigDirs = { claudeConfigDir?: string; codexHome?: string };

/** D:Fpe 97081 */
function notFound(source: AiToolSource): AiToolDiscovery { return { source, found: false, sessionCount: 0, items: [] }; }
/** D:pJe 97084 — approval description: global read-ai-tool-setup on the product label. */
export function describeAiToolDiscovery(source: AiToolSource): { action: "read-ai-tool-setup"; target: string } {
  return { action: "read-ai-tool-setup", target: LABEL[source] };
}

// D:Ojt/Mjt/Njt/Djt/Ljt 97087–97101 (verbatim).
const SECRETS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b/g,
  /\bxox[abpors]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /(?<=[=:]\s?)[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/_-])/g,
  /\b[A-Fa-f0-9]{32,}\b/g,
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LINK = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi;
const UNIX_PATH = /(?<![\w.:-])(?:~|\.{1,2})?(?:\/[^\s/<>"'`,;)]+){2,}\/?/g;
const WIN_PATH = /\b[A-Za-z]:\\(?:[^\s\\<>"'`,;)]+\\?)+/g;
/** D:hJe 97115 */
export function truncateTitle(t: string, e: number): string { return t.length > e ? `${t.slice(0, e - 1).trimEnd()}\u2026` : t; }
/** D:bp 97102 */
export function sanitize(t: string, e = MAX_TITLE): string {
  let r = t.replace(/\s+/g, " ").trim();
  for (const n of SECRETS) r = r.replace(n, "[redacted]");
  r = r.replace(LINK, "[link]");
  r = r.replace(EMAIL, "[email]");
  r = r.replace(WIN_PATH, "[path]").replace(UNIX_PATH, "[path]");
  return truncateTitle(r, e);
}
/** D:mJe 97112 */
function namespacedTitle(parts: string[]): string { return truncateTitle(parts.map(e => sanitize(e, Number.POSITIVE_INFINITY)).join(":"), MAX_TITLE); }

// D:cHt/DJe/uHt/lHt/dHt/fHt 97545–97568.
const mcpEntry = z.object({
  command: z.string().optional().catch(undefined),
  url: z.string().optional().catch(undefined),
  type: z.string().optional().catch(undefined),
}).catch({});
const mcpMap = z.record(z.string(), mcpEntry);
const claudeGlobal = z.object({
  mcpServers: mcpMap.optional().catch(undefined),
  projects: z.record(z.string(), z.object({ mcpServers: mcpMap.optional().catch(undefined) }).catch({})).optional().catch(undefined),
});
const installedPlugins = z.object({ plugins: z.record(z.string(), z.unknown()).optional() });
const claudeHistory = z.object({ display: z.string(), timestamp: z.number().optional() });
const codexHistory = z.object({ text: z.string(), ts: z.number().optional() });
type McpEntry = z.infer<typeof mcpEntry>;
/** D:ik 97569 */
function lenient<T>(schema: z.ZodType<T>): (v: unknown) => T | undefined {
  return v => { const r = schema.safeParse(v); return r.success ? r.data : undefined; };
}
const parseClaudeGlobal = lenient(claudeGlobal), parsePlugins = lenient(installedPlugins),
  parseClaudeHistory = lenient(claudeHistory), parseCodexHistory = lenient(codexHistory);

/** D:tn 78770 */
function jsonOrUndefined(t: string): unknown { try { return JSON.parse(t); } catch { return undefined; } }

/** D:j7t/un/zi 78659–78675 — first E* code along the cause chain. */
function errnoCode(t: unknown): string | undefined {
  const seen = new Set<unknown>(); let n = t;
  while (n != null && typeof n === "object" && !seen.has(n)) {
    seen.add(n);
    const s = (n as { code?: unknown }).code;
    if (typeof s === "string" && /^E[A-Z_]+$/.test(s)) return s;
    n = (n as { cause?: unknown }).cause;
  }
  return undefined;
}
const ABSENT = Symbol("absent"); // D:_E
/** D:ak 97786 — ENOENT/ENOTDIR/ELOOP mean absent; every other error propagates. */
async function absentOk<T>(fn: () => Promise<T>): Promise<T | typeof ABSENT> {
  try { return await fn(); } catch (e) {
    const code = errnoCode(e);
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return ABSENT;
    throw e;
  }
}
async function statOrUndefined(t: string) { const e = await absentOk(() => fs.stat(t)); return e === ABSENT ? undefined : e; } // D:Hpe
async function isDir(t: string) { return (await statOrUndefined(t))?.isDirectory() ?? false; }   // D:Vpe
async function isFile(t: string) { return (await statOrUndefined(t))?.isFile() ?? false; }       // D:Wpe
/** D:Kpe 97804 — readdir withFileTypes, sorted by code-unit name, first 200. */
async function listDir(t: string, order: "asc" | "desc" = "asc"): Promise<Dirent[]> {
  const r = await absentOk(() => fs.readdir(t, { withFileTypes: true }));
  if (r === ABSENT) return [];
  const n = order === "asc" ? 1 : -1;
  return r.sort((s, o) => n * (s.name < o.name ? -1 : s.name > o.name ? 1 : 0)).slice(0, MAX_DIR_ENTRIES);
}
async function readText(t: string) { const e = await absentOk(() => fs.readFile(t, "utf8")); return e === ABSENT ? undefined : e; } // D:tqe
async function readJson<T>(t: string, parse: (v: unknown) => T | undefined): Promise<T | undefined> { // D:jJe
  const r = await readText(t);
  return r === undefined ? undefined : parse(jsonOrUndefined(r));
}
/** D:rqe 97820 — last 256 KiB of a JSONL file, partial first line dropped. One read call, as original. */
async function readJsonlTail<T>(t: string, parse: (v: unknown) => T | undefined): Promise<T[]> {
  const r = await absentOk(() => fs.open(t, "r"));
  if (r === ABSENT) return [];
  try {
    const { size: n } = await r.stat();
    const s = Math.min(n, HISTORY_TAIL), o = Buffer.alloc(s);
    await r.read(o, 0, s, n - s);
    const i = o.toString("utf8").split("\n");
    if (s < n) i.shift();
    return i.flatMap(a => { const u = parse(jsonOrUndefined(a)); return u === undefined ? [] : [u]; });
  } finally { await r.close(); }
}
async function dirLike(t: string, e: Dirent) { return e.isDirectory() || (e.isSymbolicLink() && (await isDir(t))); }   // D:XJe
async function fileLike(t: string, e: Dirent) { return e.isFile() || (e.isSymbolicLink() && (await isFile(t))); }     // D:THt

/** D:ZJe 97705 */
async function skills(t: string): Promise<AiToolItem[]> {
  const r: AiToolItem[] = [];
  for (const n of await listDir(t)) {
    const s = path.join(t, n.name);
    if ((await dirLike(s, n)) && (await isFile(path.join(s, "SKILL.md")))) r.push({ kind: "skill", title: sanitize(n.name) });
  }
  return r;
}
/** D:jpe 97716 */
async function commandFiles({ dir: t, maxDepth: e, namespace: r = [] }: { dir: string; maxDepth: number; namespace?: string[] }): Promise<AiToolItem[]> {
  const n: AiToolItem[] = [];
  for (const s of await listDir(t)) {
    const o = path.join(t, s.name);
    if (s.name.endsWith(".md") && (await fileLike(o, s))) n.push({ kind: "skill", title: namespacedTitle([...r, s.name.slice(0, -3)]) });
    else if (e > 0 && (await dirLike(o, s))) n.push(...(await commandFiles({ dir: o, maxDepth: e - 1, namespace: [...r, s.name] })));
  }
  return n;
}
/** D:QJe 97740 — count *.jsonl (max 500) newest-name-first, newest mtime. Directory recursion uses Dirent (no symlink follow). */
async function sessionFiles(t: string, e: number): Promise<{ count: number; lastActiveAtMs?: number }> {
  let r = 0, n = 0, s: number | undefined;
  const o = async (i: string, a: number): Promise<void> => {
    if (n >= MAX_SESSION_FILES) return;
    for (const l of await listDir(i, "desc")) {
      if (n >= MAX_SESSION_FILES) return;
      const d = path.join(i, l.name);
      if (l.isDirectory()) { if (a < e) await o(d, a + 1); continue; }
      if (!l.isFile() || !l.name.endsWith(".jsonl")) continue;
      n += 1; r += 1;
      const f = await statOrUndefined(d);
      if (f !== undefined) s = maxDefined(s, Math.floor(f.mtimeMs));
    }
  };
  await o(t, 0);
  return { count: r, lastActiveAtMs: s };
}
/** D:eqe 97779 */
function maxDefined(t: number | undefined, e: number | undefined) { return t === undefined ? e : e === undefined ? t : Math.max(t, e); }
/** D:vHt 97762 */
function sessionItem(t: string, e: number | undefined): AiToolItem {
  return { kind: "session", title: sanitize(t), ...(e === undefined ? {} : { occurredAtMs: Math.floor(e) }) };
}
/** D:WJe 97640 */
function historyItems(t: string, e: number | undefined): AiToolItem[] {
  const r = t.replace(PASTED, " ").trim();
  return r.length === 0 || SLASH_COMMAND.test(r) ? [] : [sessionItem(r, e)];
}
/** D:zJe 97769 */
function dedupe(t: AiToolItem[]): AiToolItem[] {
  const e = new Set<string>(), r: AiToolItem[] = [];
  for (const n of t) { const s = `${n.kind}\n${n.title}`; if (!(n.title.length === 0 || e.has(s))) { e.add(s); r.push(n); } }
  return r;
}
/** D:KJe 97644 */
function summarize(t: AiToolSource, e: AiToolItem[], r: { count: number; lastActiveAtMs?: number }, n: AiToolItem[]): AiToolDiscovery {
  const s = dedupe(e).slice(0, MAX_CONFIG_ITEMS);
  const o = dedupe(n).sort((a, u) => (u.occurredAtMs ?? 0) - (a.occurredAtMs ?? 0)).slice(0, Math.max(0, MAX_ITEMS - s.length));
  const i = maxDefined(r.lastActiveAtMs, o[0]?.occurredAtMs);
  return { source: t, found: true, sessionCount: Math.max(r.count, o.length), ...(i === undefined ? {} : { lastActiveAtMs: i }), items: [...s, ...o] };
}
/** D:YJe 97665 */
function stdioExcerpt(t: string) { return sanitize(`stdio \xB7 ${path.basename(t)}`); }
/** D:yHt 97668 */
function mcpExcerpt(t: McpEntry): string {
  if (t.command !== undefined && t.command.length > 0) return stdioExcerpt(t.command);
  const e = t.type !== undefined && t.type.length > 0 ? t.type : undefined;
  return t.url !== undefined && t.url.length > 0 ? (e ?? "http") : (e ?? "unknown");
}
/** D:GJe 97658 */
function mcpItems(t: Record<string, McpEntry> | undefined): AiToolItem[] {
  return Object.entries(t ?? {}).map(([e, r]) => ({ kind: "mcp_server", title: sanitize(e), excerpt: mcpExcerpt(r) }));
}
// D:EHt/wHt/xHt/bHt 97675–97679
const TOML_MCP = /^\s*\[\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*(\.[^\]]*)?\]\s*$/;
const TOML_TABLE = /^\s*\[/;
const TOML_COMMAND = /^\s*command\s*=\s*"([^"]*)"/;
const TOML_URL = /^\s*url\s*=\s*"/;
/** D:AHt 97680 — line-oriented scan of codex config.toml (not a TOML parser, as original). */
export function codexMcpItems(t: string | undefined): AiToolItem[] {
  if (t === undefined) return [];
  const e = new Map<string, string>(); let r: string | undefined;
  for (const n of t.split(/\r?\n/)) {
    const s = TOML_MCP.exec(n);
    if (s !== null) { const i = s[1] ?? s[2] ?? ""; if (!e.has(i)) e.set(i, "unknown"); r = s[3] === undefined ? i : undefined; continue; }
    if (TOML_TABLE.test(n)) { r = undefined; continue; }
    if (r === undefined) continue;
    const o = TOML_COMMAND.exec(n);
    if (o !== null) e.set(r, stdioExcerpt(o[1] ?? "")); else if (TOML_URL.test(n)) e.set(r, "http");
  }
  return [...e].map(([n, s]) => ({ kind: "mcp_server", title: sanitize(n), excerpt: s }));
}
/** D:qJe 97606 */
async function claudeCode({ root: t, globalConfigPath: e }: { root: string; globalConfigPath: string }): Promise<AiToolDiscovery> {
  if (!(await isDir(t)) && !(await isFile(e))) return notFound("claude_code");
  const r = await readJson(e, parseClaudeGlobal);
  const n = Object.values(r?.projects ?? {}).flatMap(u => mcpItems(u.mcpServers));
  const s = await readJson(path.join(t, "plugins", "installed_plugins.json"), parsePlugins);
  const o: AiToolItem[] = [
    ...mcpItems(r?.mcpServers),
    ...n,
    ...Object.keys(s?.plugins ?? {}).map(u => ({ kind: "plugin" as const, title: sanitize(u) })),
    ...(await skills(path.join(t, "skills"))),
    ...(await commandFiles({ dir: path.join(t, "commands"), maxDepth: 2 })),
  ];
  const i = await sessionFiles(path.join(t, "projects"), 2);
  const a = (await readJsonlTail(path.join(t, "history.jsonl"), parseClaudeHistory)).flatMap(u => historyItems(u.display, u.timestamp));
  return summarize("claude_code", o, i, a);
}
/** D:RHt 97782 */
function secondsToMs(t: number) { return t < 1e12 ? t * 1e3 : t; }
/** D:_Ht 97627 */
async function codex(t: string): Promise<AiToolDiscovery> {
  if (!(await isDir(t))) return notFound("codex");
  const e: AiToolItem[] = [
    ...codexMcpItems(await readText(path.join(t, "config.toml"))),
    ...(await skills(path.join(t, "skills"))),
    ...(await commandFiles({ dir: path.join(t, "prompts"), maxDepth: 0 })),
  ];
  const r = await sessionFiles(path.join(t, "sessions"), 4);
  const n = (await readJsonlTail(path.join(t, "history.jsonl"), parseCodexHistory)).flatMap(s => historyItems(s.text, s.ts === undefined ? undefined : secondsToMs(s.ts)));
  return summarize("codex", e, r, n);
}
/** D:JJe 97603 */
function nonBlank(t: string | undefined) { return t === undefined || t.trim().length === 0 ? undefined : t; }
/** D:VJe 97585 — CLAUDE_CONFIG_DIR / CODEX_HOME are read once at daemon start (D:187322–187325). */
export async function discoverAiTool(t: AiToolSource, e: { configDirs?: AiToolConfigDirs; homeDir?: string } = {}): Promise<AiToolDiscovery> {
  const r = e.homeDir ?? os.homedir();
  switch (t) {
    case "claude_code": {
      const n = nonBlank(e.configDirs?.claudeConfigDir);
      return claudeCode(n === undefined
        ? { root: path.join(r, ".claude"), globalConfigPath: path.join(r, ".claude.json") }
        : { root: n, globalConfigPath: path.join(n, ".claude.json") });
    }
    case "codex":
      return codex(nonBlank(e.configDirs?.codexHome) ?? path.join(r, ".codex"));
  }
}
/** D:136011–136024 — JSON.stringify(result) as UTF-8 file bytes. */
export async function discoverAiToolBytes(t: AiToolSource, e: { configDirs?: AiToolConfigDirs; homeDir?: string } = {}): Promise<Uint8Array> {
  return new Uint8Array(Buffer.from(JSON.stringify(await discoverAiTool(t, e)), "utf8"));
}
/** D:187322–187325 */
export function aiToolConfigDirsFromEnv(env: NodeJS.ProcessEnv = process.env): AiToolConfigDirs {
  return { claudeConfigDir: env.CLAUDE_CONFIG_DIR, codexHome: env.CODEX_HOME };
}
