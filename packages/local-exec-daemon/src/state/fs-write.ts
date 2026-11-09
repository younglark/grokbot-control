import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

/**
 * Port of the original's atomic writer cp (D:80591–80603, default path without noFollow).
 * - yLe (mkdirSync(dirname, recursive)) runs before the lock.
 * - MFt (D:ece Map 80590): an in-process FIFO lock table keyed by path.resolve(target). The entry is deleted when
 *   its queue empties. There is no cross-process lock.
 * - AFt: realpath(target) (ENOENT → target itself); mode = options.mode ?? stat(real).mode (ENOENT → undefined).
 *   The temp file is `${real}.${randomInt(2**32)}` (ice, wFt).
 * - gLe (D:80642–80657): open(temp, O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, mode ?? 0o666) → writeFile →
 *   (mode !== undefined ? fchmod(mode), tolerating ELe : —) → fsync(fd) → close → rename(temp, real).
 *   Any failure removes the temp file (rm force) and rethrows. The parent directory is never fsynced.
 */
const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW = 0 } = fs.constants;
export const CP_OPEN_FLAGS = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW; // D:mLe 80583
export const CP_DEFAULT_MODE = 0o666; // D:hLe 438
const TEMP_SUFFIX_RANGE = 2 ** 32; // D:wFt
const lockTable = new Map<string, Array<() => void>>(); // D:ece

/** Test seam: per-key queue length (0 when the key is not in the table). */
export function cpQueueLength(target: string): number { return lockTable.get(path.resolve(target))?.length ?? 0; }

function enter(key: string): { ready: Promise<void>; leave(): void } {
  // D:MFt 80604–80617
  const q = lockTable.get(key) ?? [];
  lockTable.set(key, q);
  const ready = new Promise<void>(res => { q.push(res); });
  if (q.length === 1) q[0]?.();
  return {
    ready,
    leave: () => { q.shift(); if (q.length === 0) lockTable.delete(key); else q[0]?.(); },
  };
}

function code(e: unknown): string | undefined {
  return e instanceof Error && "code" in e && typeof (e as NodeJS.ErrnoException).code === "string" ? (e as NodeJS.ErrnoException).code : undefined;
}
/** D:ELe — fchmod failures tolerated: ENOSYS always; EINVAL/EPERM unless running as root. */
function tolerateChmod(e: unknown): void {
  const c = code(e);
  if (!(c === "ENOSYS" || ((process.getuid === undefined || process.getuid() !== 0) && (c === "EINVAL" || c === "EPERM")))) throw e;
}

export type CpHooks = { tempDone?(): void; renameBegin?(): void; renameDone?(): void };

export async function cp(target: string, data: string | Uint8Array, options: { mode?: number } = {}, hooks: CpHooks = {}): Promise<void> {
  fs.mkdirSync(path.dirname(target), { recursive: true }); // D:yLe
  const lock = enter(path.resolve(target));
  await lock.ready;
  try {
    // D:AFt / DFt / BFt
    let real = target;
    try { real = await promisify(fs.realpath)(target); } catch (e) { if (code(e) !== "ENOENT") throw e; }
    let mode = options.mode;
    if (mode === undefined) {
      try { mode = (await promisify(fs.stat)(real)).mode; } catch (e) { if (code(e) !== "ENOENT") throw e; }
    }
    const temp = `${real}.${crypto.randomInt(TEMP_SUFFIX_RANGE)}`;
    // D:gLe
    const fd = await promisify(fs.open)(temp, CP_OPEN_FLAGS, mode ?? CP_DEFAULT_MODE);
    try {
      try {
        await promisify(fs.writeFile)(fd, data);
        if (mode !== undefined) await promisify(fs.fchmod)(fd, mode).catch(tolerateChmod);
        await promisify(fs.fsync)(fd);
      } finally {
        await promisify(fs.close)(fd);
      }
      hooks.tempDone?.();
      hooks.renameBegin?.();
      await promisify(fs.rename)(temp, real);
      hooks.renameDone?.();
    } catch (e) {
      await promisify(fs.rm)(temp, { force: true });
      throw e;
    }
  } finally {
    lock.leave();
  }
}

/** D:TLe 80946–80949: JSON.stringify(value, null, pretty ? 2 : undefined) then ALe → cp(path, text, mode ? {mode} : {}). */
export function writeJson(target: string, value: unknown, options: { pretty?: boolean; mode?: number } = {}): Promise<void> {
  return cp(target, JSON.stringify(value, null, options.pretty === true ? 2 : undefined), options.mode != null ? { mode: options.mode } : {});
}
