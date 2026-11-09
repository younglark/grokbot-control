import * as fs from "node:fs";

/**
 * The env half of sqr (D:187195–187210), run at daemon module load before the handoff:
 * - `SAND_LOCAL_EXEC_INHERITED_FDS` (Rx D:78805) is parsed with n$t (D:79641, `[{fd:int>=0, target:string(min 1)}]`,
 *   anything else → []), deleted, and wDe (D:79653) closes every listed fd whose `/proc/self/fd/<fd>` link still
 *   points at the listed target (s$t D:79644). The App's spawn wrapper Kre (main-core) sets it on the L$e path.
 * - `SAND_LOCAL_EXEC_FILE_KEY` (R7t D:187194) and `NODE_USE_SYSTEM_CA` (vTe D:78806, set to "1" by R$e) are deleted,
 *   so neither leaks into exec children. The pre-IPC file key is kept (Ly.preIpcFileKeyBase64) for the no-channel
 *   handoff path (iqr D:187256–187257); the 0.79.3 App never sets it.
 */
export const INHERITED_FDS_ENV = "SAND_LOCAL_EXEC_INHERITED_FDS";
export const PRE_IPC_FILE_KEY_ENV = "SAND_LOCAL_EXEC_FILE_KEY";
export const SYSTEM_CA_ENV = "NODE_USE_SYSTEM_CA";

type InheritedFd = { fd: number; target: string };

export function parseInheritedFds(raw: string | undefined): InheritedFd[] {
  if (raw === undefined) return [];
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(v)) return [];
  const out: InheritedFd[] = [];
  for (const e of v) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) return [];
    const { fd, target } = e as Record<string, unknown>;
    if (typeof fd !== "number" || !Number.isInteger(fd) || fd < 0) return [];
    if (typeof target !== "string" || target.length < 1) return [];
    out.push({ fd, target });
  }
  return out;
}

export function closeInheritedFds(fds: InheritedFd[], readlink = (fd: number) => fs.readlinkSync(`/proc/self/fd/${fd}`), close = (fd: number) => fs.closeSync(fd)): number[] {
  const closed: number[] = [];
  for (const { fd, target } of fds) {
    let link: string | undefined;
    try { link = readlink(fd); } catch { link = undefined; }
    if (link !== target) continue;
    try { close(fd); closed.push(fd); } catch { /* Uh: ignore */ }
  }
  return closed;
}

export function scrubBootEnv(env: NodeJS.ProcessEnv = process.env, close?: (fds: InheritedFd[]) => number[]): { inheritedFds: InheritedFd[]; closedFds: number[]; preIpcFileKeyBase64: string | null } {
  const inheritedFds = parseInheritedFds(env[INHERITED_FDS_ENV]);
  delete env[INHERITED_FDS_ENV];
  const r = env[PRE_IPC_FILE_KEY_ENV] ?? null; // D:187198, validated with Bae (32 bytes) at D:187204
  delete env[PRE_IPC_FILE_KEY_ENV];
  delete env[SYSTEM_CA_ENV];
  return { inheritedFds, closedFds: (close ?? closeInheritedFds)(inheritedFds),
    preIpcFileKeyBase64: r != null && Buffer.from(r, "base64").length === 32 ? r : null };
}
