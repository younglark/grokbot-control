import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { describeError } from "../box/provider";
import { openMaybeSealed } from "../state/connection";
import type { LocalToolOutcome } from "./local-tools";

/** Port of the original Obsidian vault device tools: Ipt (D:135418) plus helpers D:135044–135400. */
export const MAC_READ_OBSIDIAN = "mac_read_obsidian"; // D:Sb 79439
export const MAC_WRITE_OBSIDIAN = "mac_write_obsidian"; // D:ose 79440
export const DEVICE_TOOLS_GATE_FILE = "mac-device-tools-gate.json"; // D:bTe (jFt = Zn()/bTe)
export const OBSIDIAN_VAULT_FILE = "obsidian-vault.json"; // D:JEr

const BODY_MAX = 20_000; // D:D5e
const LIST_DEFAULT = 20; // D:qEr
const LIST_MAX = 50; // D:gpt
const QUERY_MAX = 200; // D:Spt
const TITLE_MAX = 200; // D:L5e
const SNIPPET_CHARS = 240; // D:GEr
const SEARCH_CHARS = 200_000; // D:zEr
const MD = ".md"; // D:A_
export const OUTSIDE_VAULT = "That path is outside the Obsidian vault."; // D:ql
export const NOTE_MISSING = "That note isn't in the vault."; // D:mpt
export const VAULT_GONE = "The Obsidian vault folder is no longer on this Mac."; // D:M5e
export const TITLE_TAKEN = "A note with that title is already in that folder."; // D:k5e
export const TITLE_MISMATCH = "That note's title doesn't match. Read it again, then add to it."; // D:jEr
export const BAD_TITLE = "That title can't be a note name."; // D:_pt
export const INPUT_NOT_JSON = "The tool's input was not valid JSON."; // D:ZEr
export const INPUT_INVALID = "The tool's input was not valid."; // D:Tpt
export const VAULT_FAILED = "This Mac couldn't use the Obsidian vault."; // D:XEr
export const NO_VAULT = "No Obsidian vault is chosen on this Mac."; // D:QEr

class ObsidianVaultRefusal extends Error { override name = "ObsidianVaultRefusal"; } // D:Vr
const VaultConfig = z.object({ path: z.string().min(1) }).strict(); // D:HEr

function errCode(e: unknown): string | undefined {
  return e instanceof Error && "code" in e && typeof (e as NodeJS.ErrnoException).code === "string" ? (e as NodeJS.ErrnoException).code : undefined;
}
/** D:zi 78672 */
function missing(e: unknown): boolean { const c = errCode(e); return c === "ENOENT" || c === "ENOTDIR"; }
/** D:ML with E2 = "en" */
function fold(t: string): string { return t.toLocaleLowerCase("en").replaceAll("\u03C2", "\u03C3"); }

/** D:QR 81023 via _d(failOpen) + up(bLe): any read/parse/shape failure → false; only isOn === true opens the gate. */
export async function readDeviceToolsGate(dataRoot: string): Promise<boolean> {
  let text: string;
  try { text = await fsp.readFile(path.join(dataRoot, DEVICE_TOOLS_GATE_FILE), "utf8"); } catch { return false; }
  const plain = openMaybeSealed(text, null);
  if (plain == null) return false;
  let v: unknown;
  try { v = JSON.parse(plain); } catch { return false; }
  const p = z.object({ isOn: z.boolean() }).safeParse(v);
  return p.success && p.data.isOn === true;
}

/** D:ypt 135075 */
export async function readVaultPath(dataRoot: string, log: (m: string) => void = () => {}): Promise<string | null> {
  let r: string;
  try { r = await fsp.readFile(path.join(dataRoot, OBSIDIAN_VAULT_FILE), "utf8"); }
  catch (o) { if (!missing(o)) log(`obsidian vault config read failed: ${describeError(o)}`); return null; }
  let n: unknown;
  try { n = JSON.parse(r); } catch (o) { log(`obsidian vault config read failed: ${describeError(o)}`); return null; }
  const s = VaultConfig.safeParse(n);
  if (!s.success) { log("obsidian vault config read failed: invalid schema"); return null; }
  try { return (await fsp.stat(s.data.path)).isDirectory() ? s.data.path : null; }
  catch (o) { if (!missing(o)) log(`obsidian vault config read failed: ${describeError(o)}`); return null; }
}

/** D:NL */
function segments(t: string): string[] {
  if (t.includes("\0")) throw new ObsidianVaultRefusal(OUTSIDE_VAULT);
  const e = t.split(/[/\\]/);
  if (e.length === 0 || e.some(r => r.length === 0 || r === "." || r === ".." || r.startsWith("."))) throw new ObsidianVaultRefusal(OUTSIDE_VAULT);
  return e;
}
/** D:_9 — strictly inside */
function inside(t: string, e: string): void {
  const r = path.relative(t, e);
  if (r === "" || r.startsWith("..") || path.isAbsolute(r)) throw new ObsidianVaultRefusal(OUTSIDE_VAULT);
}
/** D:hpt — inside or equal */
function insideOrSame(t: string, e: string): void {
  const r = path.relative(t, e);
  if (r.startsWith("..") || path.isAbsolute(r)) throw new ObsidianVaultRefusal(OUTSIDE_VAULT);
}
/** D:Ept */
async function vaultRoot(t: string): Promise<string> {
  try {
    const e = await fsp.realpath(t);
    if (!(await fsp.stat(e)).isDirectory()) throw new ObsidianVaultRefusal(VAULT_GONE);
    return e;
  } catch (e) {
    throw e instanceof ObsidianVaultRefusal ? e : new ObsidianVaultRefusal(VAULT_GONE, { cause: e });
  }
}
/** D:N5e */
function noteId(t: string, e: string): string { return path.relative(t, e).split(path.sep).join("/"); }
/** D:DL */
function folderOf(t: string, e: string): string { const r = path.dirname(path.relative(t, e)); return r === "." ? "" : r.split(path.sep).join("/"); }
/** D:y9 */
function stripMd(t: string): string { return t.toLowerCase().endsWith(MD) ? t.slice(0, -MD.length) : t; }
/** D:WEr */
function noteFileName(t: string): string {
  const e = t.trim();
  if (e.length === 0 || e.length > TITLE_MAX || e.includes("/") || e.includes("\\") || e.includes("\0") || e.startsWith(".")) throw new ObsidianVaultRefusal(BAD_TITLE);
  return e.toLowerCase().endsWith(MD) ? e : `${e}${MD}`;
}
/** D:O5e */
async function readPrefix(t: string, e: number): Promise<{ text: string; truncated: boolean }> {
  const r = await fsp.open(t, "r");
  try {
    const n = await r.stat();
    const s = Math.min(n.size, e * 4);
    const o = Buffer.alloc(s);
    const { bytesRead: i } = await r.read(o, 0, s, 0);
    const a = o.subarray(0, i).toString("utf8");
    return { text: a.length > e ? a.slice(0, e) : a, truncated: n.size > i || a.length > e };
  } finally { await r.close(); }
}
/** D:E9 */
function skipped(t: unknown, log: (m: string) => void, what: string): void { log(`obsidian vault ${what} skipped: ${describeError(t)}`); }

type Listed = { id: string; title: string; folder: string; modifiedAtMs: number; absolute: string };
/** D:wpt */
async function walk(t: string, e: string, r: Listed[], n: (m: string) => void): Promise<void> {
  let s: import("node:fs").Dirent[];
  try { s = await fsp.readdir(e, { withFileTypes: true }); }
  catch (o) { if (e === t) throw new ObsidianVaultRefusal(VAULT_GONE, { cause: o }); skipped(o, n, "folder"); return; }
  for (const o of s) {
    if (o.name.startsWith(".") || o.isSymbolicLink()) continue;
    const i = path.join(e, o.name);
    if (o.isDirectory()) { await walk(t, i, r, n); continue; }
    if (!o.isFile() || !o.name.toLowerCase().endsWith(MD)) continue;
    let a: string;
    try { a = await fsp.realpath(i); } catch (d) { skipped(d, n, "note"); continue; }
    const u = path.relative(t, a);
    if (u.startsWith("..") || path.isAbsolute(u)) continue;
    let l: import("node:fs").Stats;
    try { l = await fsp.stat(a); } catch (d) { skipped(d, n, "note"); continue; }
    r.push({ id: u.split(path.sep).join("/"), title: stripMd(o.name), folder: folderOf(t, a), modifiedAtMs: l.mtimeMs, absolute: a });
  }
}
/** D:xpt */
async function existingNote(t: string, e: string): Promise<string> {
  const r = segments(e);
  const n = r[r.length - 1];
  if (n === undefined || !n.toLowerCase().endsWith(MD)) throw new ObsidianVaultRefusal(NOTE_MISSING);
  const s = path.resolve(t, ...r);
  inside(t, s);
  let o: string;
  try {
    const i = await fsp.lstat(s);
    if (i.isSymbolicLink() || !i.isFile()) throw new ObsidianVaultRefusal(OUTSIDE_VAULT);
    o = await fsp.realpath(s);
  } catch (i) {
    throw i instanceof ObsidianVaultRefusal ? i : new ObsidianVaultRefusal(NOTE_MISSING, { cause: i });
  }
  inside(t, o);
  return o;
}
/** D:KEr */
async function newNotePath(t: string, e: string[]): Promise<string> {
  const r = e[e.length - 1];
  if (r === undefined) throw new ObsidianVaultRefusal(OUTSIDE_VAULT);
  let n = t;
  const s = e.slice(0, -1);
  let o: number | undefined;
  for (let a = 0; a < s.length; a += 1) {
    const u = s[a];
    if (u === undefined) throw new ObsidianVaultRefusal(OUTSIDE_VAULT);
    const l = path.resolve(n, u);
    inside(t, l);
    let d: import("node:fs").Stats;
    try { d = await fsp.lstat(l); }
    catch (f) { if (!missing(f)) throw new ObsidianVaultRefusal(OUTSIDE_VAULT, { cause: f }); o = a; break; }
    if (d.isSymbolicLink() || !d.isDirectory()) throw new ObsidianVaultRefusal(OUTSIDE_VAULT);
    n = await fsp.realpath(l); insideOrSame(t, n);
  }
  if (o !== undefined) {
    n = path.resolve(n, ...s.slice(o)); inside(t, n);
    await fsp.mkdir(n, { recursive: true });
    n = await fsp.realpath(n); insideOrSame(t, n);
  }
  const i = path.resolve(n, r);
  inside(t, i);
  return i;
}

const ReadInput = z.object({
  query: z.string().trim().min(1).max(QUERY_MAX).optional(),
  folder: z.string().trim().min(1).optional(),
  id: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(LIST_MAX).optional(),
}).refine(({ id, query, folder, limit }) => id === undefined || [query, folder, limit].every(s => s === undefined), { message: "pass id alone to read one note" }); // D:e6r
const WriteInput = z.object({
  id: z.string().min(1).optional(),
  currentTitle: z.string().optional(),
  title: z.string().trim().min(1).max(TITLE_MAX).optional(),
  body: z.string().min(1).max(BODY_MAX),
  folder: z.string().trim().min(1).optional(),
}).refine(({ id, title }) => (id === undefined) !== (title === undefined), { message: "pass title for a new note, or id to add to an existing note" })
  .refine(({ id, currentTitle }) => (id === undefined) === (currentTitle === undefined), { message: "pass currentTitle with id, and only with id" })
  .refine(({ id, folder }) => id === undefined || folder === undefined, { message: "folder only applies to a new note" }); // D:t6r

/** D:bpt 135266 */
export async function readVault(vault: string, e: z.infer<typeof ReadInput>, log: (m: string) => void = () => {}): Promise<unknown> {
  const n = await vaultRoot(vault);
  if (e.id !== undefined) {
    const f = await existingNote(n, e.id);
    const p = await fsp.stat(f);
    const { text: m, truncated: h } = await readPrefix(f, BODY_MAX);
    return { note: { id: noteId(n, f), title: stripMd(path.basename(f)), folder: folderOf(n, f), modifiedAt: p.mtime.toISOString(), body: m, bodyTruncated: h } };
  }
  const s: Listed[] = [];
  await walk(n, n, s, log);
  const o = e.folder === undefined ? undefined : segments(e.folder).join("/");
  const i = s.filter(f => o === undefined || f.folder === o).sort((f, p) => p.modifiedAtMs - f.modifiedAtMs || f.id.localeCompare(p.id));
  const a = e.limit ?? LIST_DEFAULT;
  const u = e.query === undefined ? undefined : fold(e.query);
  const l: unknown[] = [];
  let d = false;
  for (const f of i) {
    if (!(u === undefined || fold(f.title).includes(u))) {
      let h: string;
      try { h = (await readPrefix(f.absolute, SEARCH_CHARS)).text; } catch (g) { skipped(g, log, "note"); continue; }
      if (!fold(h).includes(u ?? "")) continue;
    }
    let m: string;
    try { m = (await readPrefix(f.absolute, SNIPPET_CHARS)).text; } catch (h) { skipped(h, log, "note"); continue; }
    if (l.length === a) { d = true; break; }
    l.push({ id: f.id, title: f.title, folder: f.folder, modifiedAt: new Date(f.modifiedAtMs).toISOString(), snippet: m }); // D:YEr
  }
  return { notes: l, truncated: d };
}

/** D:Apt 135321 */
export async function writeVault(vault: string, e: z.infer<typeof WriteInput>): Promise<unknown> {
  const r = await vaultRoot(vault);
  if (e.id === undefined) {
    if (e.title === undefined) throw new ObsidianVaultRefusal(BAD_TITLE);
    const u = noteFileName(e.title);
    const l = [...(e.folder === undefined ? [] : segments(e.folder)), u];
    const d = await newNotePath(r, l);
    try {
      throw (await fsp.lstat(d)).isSymbolicLink() ? new ObsidianVaultRefusal(OUTSIDE_VAULT) : new ObsidianVaultRefusal(TITLE_TAKEN);
    } catch (f) {
      if (f instanceof ObsidianVaultRefusal) throw f;
      if (!missing(f)) throw new ObsidianVaultRefusal(TITLE_TAKEN, { cause: f });
    }
    try { await fsp.writeFile(d, e.body, { encoding: "utf8", flag: "wx" }); }
    catch (f) {
      throw f instanceof ObsidianVaultRefusal ? f : errCode(f) === "EEXIST" ? new ObsidianVaultRefusal(TITLE_TAKEN, { cause: f }) : f;
    }
    return { action: "created", note: { id: noteId(r, d), title: stripMd(u), folder: folderOf(r, d) } };
  }
  const n = segments(e.id);
  const s = n[n.length - 1];
  if (s === undefined || stripMd(s) !== e.currentTitle) throw new ObsidianVaultRefusal(TITLE_MISMATCH);
  const o = await existingNote(r, e.id);
  const i = await fsp.stat(o);
  let a = "";
  if (i.size > 0) {
    const u = await fsp.open(o, "r");
    try {
      const l = Buffer.alloc(1);
      await u.read(l, 0, 1, i.size - 1);
      if (l.toString("utf8") !== "\n") a = "\n";
    } finally { await u.close(); }
  }
  await fsp.appendFile(o, `${a}${e.body}`, "utf8");
  return { action: "appended", note: { id: noteId(r, o), title: stripMd(s), folder: folderOf(r, o) } };
}

function isObsidianTool(t: string): boolean { return t === MAC_READ_OBSIDIAN || t === MAC_WRITE_OBSIDIAN; } // D:vpt
const failed = (error: string): LocalToolOutcome => ({ status: "failed", error }); // D:T_
const done = (v: unknown): LocalToolOutcome => ({ status: "done", outputJson: JSON.stringify(v) }); // D:Rpt

export type AnnouncedDeviceTool = { toolId: string; state: string; features?: string[] };

/** D:Ipt 135418 */
export function obsidianTools(t: { rootDir: () => string; readGate?: () => Promise<boolean>; log?: (m: string) => void }) {
  const e = t.readGate ?? (() => readDeviceToolsGate(t.rootDir()));
  const r = t.log ?? (() => {});
  let n: string | null = null;
  return {
    announced: (): AnnouncedDeviceTool[] => n == null ? [] : [{ toolId: MAC_READ_OBSIDIAN, state: "ready" }, { toolId: MAC_WRITE_OBSIDIAN, state: "ready" }],
    offers: (s: string) => n != null && isObsidianTool(s),
    refresh: async () => {
      let s = false;
      try { s = await e(); } catch (o) { r(`obsidian vault gate read failed: ${describeError(o)}`); }
      try { n = s ? await readVaultPath(t.rootDir(), r) : null; }
      catch (o) { r(`obsidian vault read failed: ${describeError(o)}`); n = null; }
    },
    run: async (s: { toolId: string; inputJson: string }): Promise<LocalToolOutcome> => {
      if (!isObsidianTool(s.toolId) || n == null) return failed(NO_VAULT);
      let o: unknown;
      try { o = JSON.parse(s.inputJson); } catch { return failed(INPUT_NOT_JSON); }
      try {
        if (s.toolId === MAC_READ_OBSIDIAN) {
          const a = ReadInput.safeParse(o);
          return a.success ? done(await readVault(n, a.data, r)) : failed(INPUT_INVALID);
        }
        const i = WriteInput.safeParse(o);
        return i.success ? done(await writeVault(n, i.data)) : failed(INPUT_INVALID);
      } catch (i) {
        return i instanceof ObsidianVaultRefusal ? failed(i.message) : failed(VAULT_FAILED);
      }
    },
  };
}
