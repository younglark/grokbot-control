import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { z as z4 } from "zod/v4";
import { dataRootFromEnv } from "./util";
import { describeError } from "./box/provider";

const Permission = z.enum(["never", "ask", "always"]);

export const SettingsSchema = z
  .object({
    version: z.literal(1),
    localToolPermission: Permission.optional(),
    localToolPermissionCeiling: Permission.optional(),
    // D:zqt 82042–82044 defaults false/true/true; aue 82084–82086 on unreadable/invalid.
    messagesEnabled: z.boolean().optional(),
    messagesReadEnabled: z.boolean().optional(),
    messagesSendEnabled: z.boolean().optional(),
  })
  .passthrough();

export type Settings = z.infer<typeof SettingsSchema>;

/**
 * D:zqt 82019–82060 / jUe 82069 (zod v4, as bundled): the whole settings document must validate, or the store treats
 * the file as unreadable and every getter falls back to aue() defaults (D:82063–82080; II.load 82272–82393).
 * Only acceptance matters here; the fields this daemon reads are taken from SettingsSchema below.
 */
const tI = ["always", "ask", "never"] as const; // D:81060
const IUe = ["all-temporal", "has-box-agent"] as const; // D:81548
const CUe = ["system", "light", "dark"] as const; // D:81549
const OUe = ["ping-1-open-blip", "ping-2-tick", "ping-3-double-tick", "ping-4-chime-a", "ping-5-chime-b"] as const; // D:81552
const NUe = ["system", "en", "hi", "zh-CN", "zh-TW", "pl", "es", "pt", "ja", "fr", "ko", "de", "ru", "tr", "ar", "it", "sv", "uk", "nl",
  "el", "af", "he", "vi", "id", "ur", "th", "bn", "cs", "hu", "nb", "da", "fi", "mr", "te", "sw", "ha", "ta", "pt-PT", "sl"] as const; // D:Mqt/Nqt 81757
const iue = ["stable", "nightly", "dogfood"] as const; // D:81984
function Bf(t: unknown): boolean { // D:Bf 78779–78794
  if (t === null) return true;
  switch (typeof t) {
    case "string": case "boolean": return true;
    case "number": return Number.isFinite(t);
    case "object": return Array.isArray(t) ? t.every(Bf) : Object.values(t as object).every(Bf);
    default: return false;
  }
}
const Pqt = z4.object({ id: z4.string().min(1), value: z4.string() }); // D:81521
const vUe = z4.object({ modelId: z4.string().min(1), maxMode: z4.boolean(), parameters: z4.array(Pqt) })
  .refine(t => t.modelId.trim().length > 0, { path: ["modelId"] }); // D:81522–81523
const zUe = z4.array(z4.string().min(1)); // D:81990 (transform drops invalid ids; never rejects)
const Jqt = z4.object({ isEnabled: z4.boolean().default(true), allowInstructions: z4.array(z4.string()).default([]), blockInstructions: z4.array(z4.string()).default([]) });
const qqt = z4.object({ isEnabled: z4.boolean(), allowedApps: z4.array(z4.string()), minIntervalMs: z4.number(), maxPerWindow: z4.number(), windowMs: z4.number() }).partial();
const Gqt = z4.object({ playSound: z4.boolean(), sound: z4.enum(OUe) });
const VUe = {
  mcpCustomInstructions: z4.record(z4.string(), z4.string()).default({}),
  mcpCustomInstructionsByServerId: z4.record(z4.string(), z4.string()).default({}),
  mcpDisabledToolsByServerId: z4.record(z4.string(), z4.array(z4.string())).default({}),
  autoReviewInstructions: Jqt.optional(),
  toolPermissions: z4.custom(Bf).optional(),
  computerUseModel: vUe.optional().catch(undefined),
  localToolPermission: z4.enum(tI).optional(),
  localToolPermissionCeiling: z4.enum(tI).optional(),
  localEgressAllowed: z4.boolean().optional(),
  boxRosterCensus: z4.enum(IUe).optional().catch(undefined),
};
const RI = z4.object(VUe);
export const FullSettingsSchema = z4.object({
  version: z4.literal(1),
  mcpBoxServers: z4.array(z4.string().min(1)).default([]),
  hasSeenOnboarding: z4.boolean().optional(),
  hasSeenOnboardingAccountScope: z4.string().min(1).optional(),
  selectedTeam: z4.object({ teamId: z4.number().int().positive().safe(), accountScope: z4.string().min(1) }).optional().catch(undefined),
  autoUpdateWhenIdle: z4.boolean().default(true),
  updateTrackOverride: z4.enum(iue).optional(),
  ...VUe,
  activeAccountScope: z4.string().min(1).optional(),
  themePreference: z4.enum(CUe).optional(),
  languagePreference: z4.enum(NUe).optional(),
  egressTunnelEnabled: z4.boolean().default(false),
  egressTunnelPreference: z4.boolean().optional(),
  egressTunnelCommittedBoxUrls: z4.array(z4.string().min(1)).optional(),
  webauthnProxyEnabled: z4.boolean().default(true),
  botColorInChatEnabled: z4.boolean().default(false),
  botColorInChatPreference: z4.boolean().optional(),
  messagesEnabled: z4.boolean().default(false),
  messagesReadEnabled: z4.boolean().default(true),
  messagesSendEnabled: z4.boolean().default(true),
  macMailSendEnabled: z4.boolean().default(false),
  hardwareAccelerationEnabled: z4.boolean().optional(),
  isSpellCheckEnabled: z4.boolean().optional(),
  notifications: qqt.optional(),
  desktopNotificationPreferences: Gqt.optional(),
  userTimeZone: z4.string().min(1).optional(),
  userTimeZoneOverride: z4.string().min(1).optional(),
  pinnedAgentIds: zUe.optional(),
  localToolPermissionByMachineId: z4.record(z4.string(), z4.enum(tI)).optional(),
  sidebarSections: z4.array(z4.object({ id: z4.string().min(1), name: z4.string(), agentIds: zUe, isCollapsed: z4.boolean() })).optional(),
  accountScopes: z4.record(z4.string(), RI).default({}),
  mcpCustomInstructionsAccountScope: z4.string().min(1).optional(), // jUe extend (D:82069–82071)
});

/**
 * D:N9r 179155–179160 → BDe({log:_c}) 79832–79875: the daemon's settings store reports an unreadable file once per
 * (path, kind, cause) per process: `[local-exec-daemon] durable file damaged path=settings.json cause=${xt} copy=none`,
 * or `durable file unsupported path=settings.json version=N` when the document names another numeric version (tGt 82208).
 */
const reported = new Set<string>();
function report(kind: string, cause: string, line: string): void {
  const key = JSON.stringify(["settings.json", kind, cause]);
  if (reported.has(key)) return;
  reported.add(key);
  console.error(`[local-exec-daemon] ${line}`);
}
function reportUnreadable(error: unknown, raw: unknown): void {
  const v = typeof raw === "object" && raw !== null && "version" in raw ? (raw as { version: unknown }).version : undefined;
  if (typeof v === "number" && v !== 1) { report("unsupported-version", "unsupported-version", `durable file unsupported path=settings.json version=${v}`); return; }
  const a = describeError(error);
  report("damaged", a, `durable file damaged path=settings.json cause=${a} copy=none`);
}
export type PermissionMode = z.infer<typeof Permission>;

type Loaded = { settings: Settings; permission: PermissionMode; damaged: boolean };

export async function loadSettings(env: NodeJS.ProcessEnv = process.env): Promise<Loaded> {
  return loadSettingsSync(env);
}

/**
 * t108u: per-request synchronous read, as the official settings store does on every getLocalToolPermission()
 * (D:L82881 → load() L82271 → readText() → pue: `existsSync(t) ? readFileSync(t,"utf-8") : void 0`).
 * No cache and no shared promise: each call reads the file again.
 */
export function loadSettingsSync(env: NodeJS.ProcessEnv = process.env): Loaded {
  const file = path.join(dataRootFromEnv(env), "settings.json");
  let text: string | undefined;
  try { text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined; }
  catch (e) {
    // D:II.readText 82258–82270 via pue (no isRefusedRead): zi(ENOENT/ENOTDIR) skips onDamage then still
    // rethrows; any other read error calls onDamage (copy none) and then rethrows. load() does not catch.
    const c = (e as { code?: unknown }).code;
    if (c !== "ENOENT" && c !== "ENOTDIR") {
      report("damaged", describeError(e), `durable file damaged path=settings.json cause=${describeError(e)} copy=none`);
    }
    throw e;
  }
  if (text === undefined) return parseSettings(null);
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch (e) { reportUnreadable(e, undefined); return { settings: { version: 1 }, permission: "ask", damaged: true }; }
  const full = FullSettingsSchema.safeParse(raw);
  if (!full.success) { reportUnreadable(full.error, raw); return { settings: { version: 1 }, permission: "ask", damaged: true }; }
  return parseSettings(raw);
}

function parseSettings(raw: unknown): Loaded {
  if (raw == null) {
    return { settings: { version: 1 }, permission: "ask", damaged: false };
  }
  const parsed = SettingsSchema.safeParse(raw);
  if (!parsed.success) {
    // Official falls back to Ask on ZodError / missing version.
    return { settings: { version: 1 }, permission: "ask", damaged: true };
  }
  return {
    settings: parsed.data,
    permission: effectivePermission(parsed.data.localToolPermission ?? "ask", parsed.data.localToolPermissionCeiling),
    damaged: false,
  };
}

/** Official nI: lower rank is more restrictive. Invalid schema never reaches it. */
export function effectivePermission(permission: PermissionMode, ceiling?: PermissionMode): PermissionMode {
  const rank = { never: 0, ask: 1, always: 2 };
  return ceiling !== undefined && rank[ceiling] < rank[permission] ? ceiling : permission;
}

/** D:getMessagesEnabled 82533 / getMessagesCapabilities 82541 with zod defaults (false / true / true). */
export function messagesSettings(l: Loaded): { enabled: boolean; read: boolean; send: boolean } {
  if (l.damaged) return { enabled: false, read: true, send: true };
  return { enabled: l.settings.messagesEnabled ?? false, read: l.settings.messagesReadEnabled ?? true, send: l.settings.messagesSendEnabled ?? true };
}
