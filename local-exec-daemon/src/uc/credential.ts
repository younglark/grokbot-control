import * as path from "node:path";
import { z } from "zod";
import { dataRootFromEnv, readJsonIfExists } from "../util";
import { unsealJson } from "./sealed";

const UserComputerChannelSchema = z.object({
  credential: z.string().min(1),
  machineId: z.string().min(1),
  accountScope: z.string().optional(),
  serverAuthoritative: z.boolean().optional(),
});

const CredentialPayloadSchema = z.object({
  backendUrl: z.string().min(1),
  userComputer: UserComputerChannelSchema.optional(),
  userComputers: z.array(UserComputerChannelSchema).optional(),
  box: z.unknown().optional(),
});

export type CredentialPayload = z.infer<typeof CredentialPayloadSchema>;
export type UserComputerChannelCred = z.infer<typeof UserComputerChannelSchema>;

export function credentialPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dataRootFromEnv(env), "local-exec-daemon-credential.json");
}

/**
 * Load sealed credential file using the IPC file key.
 * Does not log credential material.
 */
export async function loadSealedCredential(
  fileKeyB64: string,
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
  const plain = unsealJson(fileKeyB64, raw);
  const parsed = CredentialPayloadSchema.safeParse(JSON.parse(plain));
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
