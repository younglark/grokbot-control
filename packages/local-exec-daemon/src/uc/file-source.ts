/** UC outer download -> Ype/oqe; UC outer upload -> n9 + approximate cp write.
 * Static 0.79.3 D:97843–97893 / 132584–132602 / 136374–136392 / 80591–80602.
 * Box download materializes the same Ype source via iqe (D:97895–97906 / 137534–137544).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
export const UC_FILE_CHUNK_BYTES = 1024 * 1024;
export const UC_MAX_FILE_BYTES = 100 * 1024 * 1024;
export type FileRead = { kind: "data"; data: Uint8Array<ArrayBuffer>; last: boolean } | { kind: "error"; error: string };
export interface FileSource { read(): Promise<FileRead>; close(): void }
const message = (e: unknown): string => e instanceof Error ? e.message : String(e);
export function fileTooLarge(actual: number, max: number): string {
  const mib = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `File is ${mib(actual)}, which exceeds Grok Bot's ${mib(max)} limit for reading or transferring a single file over local-exec. Read a slice with offset/limit, or use a shell command (grep, head, tail) to extract just what you need.`;
}
/** Original n9/kDe: lexical check, root realpath, nearest-existing ancestor realpath.
 * This is a path check, NOT an atomic open fence; the original check/open race is preserved.
 */
export async function resolveDownloadPath(root: string, requested: string): Promise<string> {
  const target = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(root, requested);
  const outside = (base: string, value: string) => { const rel = path.relative(base, value); return rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel)); };
  if (outside(root, target)) throw new Error(`Path is outside the allowed local-exec root and was refused: ${requested}`);
  let realRoot: string;
  try { realRoot = await fs.realpath(root); } catch { return target; }
  let parent = target; const parts: string[] = [];
  let realTarget: string;
  for (;;) {
    try { realTarget = path.join(await fs.realpath(parent), ...parts.slice().reverse()); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const up = path.dirname(parent);
      if (up === parent) { realTarget = target; break; }
      parts.push(path.basename(parent)); parent = up;
    }
  }
  if (outside(realRoot, realTarget)) throw new Error(`Path resolves through a symlink to outside the allowed local-exec root and was refused: ${requested}`);
  return target;
}
export class LocalFileSource implements FileSource {
  private opened?: Promise<{ handle: fs.FileHandle; size?: number }>;
  private handle?: fs.FileHandle;
  private closed = false;
  private sent = 0;
  constructor(private readonly file: string, private readonly maxBytes = UC_MAX_FILE_BYTES) {}
  private closeHandle(handle: fs.FileHandle): void { void handle.close().catch(() => {}); }
  close(): void { if (!this.closed) { this.closed = true; if (this.handle) this.closeHandle(this.handle); } }
  private async open(): Promise<{ handle: fs.FileHandle; size?: number }> {
    const handle = await fs.open(this.file, "r");
    this.handle = handle;
    if (this.closed) this.closeHandle(handle);
    const stat = await handle.stat();
    return { handle, size: stat.isFile() && stat.size > 0 ? stat.size : undefined };
  }
  async read(): Promise<FileRead> {
    try {
      const { handle, size } = await (this.opened ??= this.open());
      const count = size === undefined ? UC_FILE_CHUNK_BYTES : Math.min(UC_FILE_CHUNK_BYTES, size - this.sent);
      const data = new Uint8Array(count); let used = 0;
      while (used < count) {
        const { bytesRead } = await handle.read(data, used, count - used, null);
        if (bytesRead === 0) break;
        used += bytesRead;
      }
      const total = this.sent + used;
      if (total > this.maxBytes) return { kind: "error", error: fileTooLarge(total, this.maxBytes) };
      this.sent = total;
      return { kind: "data", data: data.subarray(0, used), last: used === 0 || total === size };
    } catch (e) { return { kind: "error", error: message(e) }; }
  }
}
/** Preflight stat is deliberately distinct from lazy source.open/stat. */
export async function prepareDownload(root: string, requested: string, maxBytes = UC_MAX_FILE_BYTES): Promise<FileSource> {
  const file = await resolveDownloadPath(root, requested);
  let stat;
  try { stat = await fs.stat(file); }
  catch (e) { if (!["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e; }
  if (stat?.isFile() && stat.size > maxBytes) throw new Error(fileTooLarge(stat.size, maxBytes));
  return new LocalFileSource(file, maxBytes);
}

/** Same n9 path gate as download; upload uses it after the byte-length precheck. */
export async function resolveUploadPath(root: string, requested: string): Promise<string> {
  return resolveDownloadPath(root, requested);
}
/** Approximate D:cp (80591): mkdir parent, sibling temp, write+fsync, rename.
 * Default mode 0o666 (hLe=438); preserve existing mode when present. Not the original lock table.
 */
export async function writeUploadFile(root: string, requested: string, bytes: Uint8Array, maxBytes = UC_MAX_FILE_BYTES): Promise<void> {
  if (bytes.length > maxBytes) throw new Error(fileTooLarge(bytes.length, maxBytes));
  const target = await resolveUploadPath(root, requested);
  await fs.mkdir(path.dirname(target), { recursive: true });
  let mode = 0o666;
  try { mode = (await fs.stat(target)).mode; } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const tmp = `${target}.${crypto.randomInt(1 << 30)}`;
  const handle = await fs.open(tmp, "w", mode);
  try {
    await handle.writeFile(bytes);
    try { await handle.chmod(mode); } catch { /* original ELe swallows chmod failures */ }
    await handle.sync();
  } finally { await handle.close(); }
  try { await fs.rename(tmp, target); }
  catch (e) { await fs.rm(tmp, { force: true }); throw e; }
}
/** D:iqe 97895–97906 — materialize a FileSource for Box JSON bytesBase64 replies. */
export async function readWholeFile(source: FileSource): Promise<{ bytes: Uint8Array<ArrayBuffer> } | { error: string }> {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  try {
    for (;;) {
      const next = await source.read();
      if (next.kind === "error") return { error: next.error };
      parts.push(next.data);
      if (next.last) {
        const total = parts.reduce((n, p) => n + p.length, 0);
        const out = new Uint8Array(total);
        let o = 0;
        for (const part of parts) { out.set(part, o); o += part.length; }
        return { bytes: out };
      }
    }
  } finally { source.close(); }
}
