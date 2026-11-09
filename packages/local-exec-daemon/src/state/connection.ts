import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { dataRootFromEnv } from "../util";
import { sealJson } from "../uc/sealed";
import { cp, writeJson } from "./fs-write";

/** D:UFt 80874 */
const ConnectionSchema = z.object({
  baseUrl: z.string().min(1),
  token: z.string().optional(),
  headers: z.record(z.string()).optional(),
});

export type Connection = z.infer<typeof ConnectionSchema>;

/** D:XR / gTe "local-exec-daemon-connection.json" (80916, 78796) */
export function connectionPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dataRootFromEnv(env), "local-exec-daemon-connection.json");
}

/**
 * D:RDe 79701 / c$t: a `{sandSealedFile:1, data}` envelope is opened with the IPC file key (AES-256-GCM, iv 12,
 * tag 16); no key or a failed open → null. Any other text is returned as is (plain JSON is still accepted).
 */
export function openMaybeSealed(text: string, fileKeyB64: string | null | undefined): string | null {
  let env: unknown;
  try { env = JSON.parse(text); } catch { env = undefined; }
  const sealed = typeof env === "object" && env !== null && !Array.isArray(env)
    && (env as Record<string, unknown>).sandSealedFile === 1 && typeof (env as Record<string, unknown>).data === "string"
    ? (env as { data: string }).data : null;
  if (sealed == null) return text;
  if (fileKeyB64 == null) return null;
  try {
    const s = Buffer.from(sealed, "base64");
    const d = crypto.createDecipheriv("aes-256-gcm", Buffer.from(fileKeyB64, "base64"), s.subarray(0, 12));
    d.setAuthTag(s.subarray(12, 28));
    return Buffer.concat([d.update(s.subarray(28)), d.final()]).toString("utf8");
  } catch { return null; }
}

/**
 * D:RLe 80974–80985 via _d (D:80952): ENOENT → null; other read errors throw (no failOpen); RDe; tn (JSON.parse →
 * undefined); up(UFt) → null on schema failure. Returns {baseUrl, token?, headers?}.
 */
export async function loadConnection(env: NodeJS.ProcessEnv = process.env, fileKeyB64: string | null = null): Promise<Connection | null> {
  let text: string;
  try { text = await fs.promises.readFile(connectionPath(env), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  const plain = openMaybeSealed(text, fileKeyB64);
  if (plain == null) return null;
  let raw: unknown;
  try { raw = JSON.parse(plain); } catch { raw = undefined; }
  const parsed = ConnectionSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { baseUrl, token, headers } = parsed.data;
  return { baseUrl, ...(token === undefined ? {} : { token }), ...(headers === undefined ? {} : { headers }) };
}

/** D:vLe 80967–80973: no key → TLe(path, connection, {mode: 0o600}); key → ALe(path, vDe(key, JSON), 0o600). */
export function writeConnection(connection: Connection, fileKeyB64: string | null, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const p = connectionPath(env);
  return fileKeyB64 == null
    ? writeJson(p, connection, { mode: 0o600 })
    : cp(p, sealJson(fileKeyB64, JSON.stringify(connection)), { mode: 0o600 });
}
