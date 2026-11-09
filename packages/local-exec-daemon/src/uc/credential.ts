import * as path from "node:path";
import { z } from "zod";
import { dataRootFromEnv, readJsonIfExists } from "../util";
import { openMaybeSealed } from "../state/connection";

const UserComputerChannelSchema = z.object({
  credential: z.string().min(1),
  machineId: z.string().min(1),
  accountScope: z.string().optional(),
  serverAuthoritative: z.boolean().optional(),
});

/** D:GFt 80896: top-level credential (Box exchange) is optional; at least one of credential/userComputer(s) required. */
const CredentialPayloadSchema = z.object({
  credential: z.string().min(1).optional(),
  backendUrl: z.string().min(1),
  userComputer: UserComputerChannelSchema.optional(),
  userComputers: z.array(UserComputerChannelSchema).optional(),
  box: z.unknown().optional(),
}).refine(e => e.credential !== undefined || e.userComputer !== undefined || (e.userComputers?.length ?? 0) > 0);

export type CredentialPayload = z.infer<typeof CredentialPayloadSchema>;
export type UserComputerChannelCred = z.infer<typeof UserComputerChannelSchema>;

export function credentialPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dataRootFromEnv(env), "local-exec-daemon-credential.json");
}

/**
 * D:ILe 80986 via _d (D:80952): ENOENT → null, other read errors throw; RDe (D:79701) opens a sealed envelope with
 * the IPC key (no key or a bad open → null) and passes any other text through as plain JSON; tn (JSON.parse →
 * undefined) then up(GFt) → null on schema failure. Does not log credential material.
 */
export async function loadSealedCredential(
  fileKeyB64: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CredentialPayload | null> {
  const p = credentialPath(env);
  let raw: string;
  try {
    const fs = await import("node:fs/promises");
    raw = await fs.readFile(p, "utf8");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const plain = openMaybeSealed(raw, fileKeyB64);
  if (plain == null) return null;
  let value: unknown;
  try { value = JSON.parse(plain); } catch { value = undefined; }
  const parsed = CredentialPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function pickUserComputerChannel(
  payload: CredentialPayload,
): (UserComputerChannelCred & { backendUrl: string }) | null {
  const ch = payload.userComputer || payload.userComputers?.[0];
  if (!ch) return null;
  return { ...ch, backendUrl: payload.backendUrl };
}

/** Plain connection JSON may still be used; sealed is preferred for UC. */
export async function loadCredentialMeta(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ exists: boolean; sealed: boolean } | null> {
  const raw = await readJsonIfExists<Record<string, unknown>>(credentialPath(env));
  if (raw == null) return null;
  return { exists: true, sealed: raw.sandSealedFile === 1 };
}
