import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { dataRootFromEnv, readJsonIfExists } from "./util";

const Permission = z.enum(["never", "ask", "always"]);

export const SettingsSchema = z
  .object({
    version: z.literal(1),
    localToolPermission: Permission.optional(),
    localToolPermissionCeiling: Permission.optional(),
  })
  .passthrough();

export type Settings = z.infer<typeof SettingsSchema>;
export type PermissionMode = z.infer<typeof Permission>;

type Loaded = { settings: Settings; permission: PermissionMode; damaged: boolean };

export async function loadSettings(env: NodeJS.ProcessEnv = process.env): Promise<Loaded> {
  const file = path.join(dataRootFromEnv(env), "settings.json");
  let raw: unknown;
  try { raw = await readJsonIfExists<unknown>(file); }
  catch { return { settings: { version: 1 }, permission: "ask", damaged: true }; }
  return parseSettings(raw);
}

/**
 * t108u: per-request synchronous read, as the official settings store does on every getLocalToolPermission()
 * (D:L82881 → load() L82271 → readText() → pue: `existsSync(t) ? readFileSync(t,"utf-8") : void 0`).
 * No cache and no shared promise: each call reads the file again.
 */
export function loadSettingsSync(env: NodeJS.ProcessEnv = process.env): Loaded {
  const file = path.join(dataRootFromEnv(env), "settings.json");
  let raw: unknown = null;
  try { if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return { settings: { version: 1 }, permission: "ask", damaged: true }; }
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
