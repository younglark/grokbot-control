/**
 * Ripgrep path state (Z2 D:19015), nl() (D:19007–19013) and b0 (D:19002–19005). Split out of ls-ripgrep.ts (t198)
 * so spawn-workload.ts (Ko) can use b0 without an import cycle. Default unset = the 0.79.3 App state.
 */
import * as path from "node:path";

/** Exact text of nl() (D:19008–19011). */
export const RIPGREP_UNCONFIGURED =
  "Ripgrep path not configured. Call configureRipgrepPath() at startup.";

/** D:Z2 (19015). Never assigned in 0.79.3; only configureRipgrepPath() sets it here. */
let Z2: string | undefined;

/** The setter the nl() message names (absent from the 0.79.3 bundle). Stores the value as given, like Z2. */
export function configureRipgrepPath(p: string): void { Z2 = p; }
/** Current Z2 (undefined = unconfigured, the 0.79.3 App state). */
export function getRipgrepPath(): string | undefined { return Z2; }

/** D:nl 19007–19013. */
export function nl(): string {
  if (!Z2) throw new Error(RIPGREP_UNCONFIGURED);
  return Z2;
}

/** D:IGe 18976 (non-win32 branch). */
function IGe(t: NodeJS.ProcessEnv): string | undefined {
  const e = Object.keys(t).filter((r) => r.toLowerCase() === "path");
  if (e.length !== 0) return process.platform === "win32" ? (e.find((r) => r === "Path") ?? e[0]) : (e.find((r) => r === "PATH") ?? e[0]);
  return undefined;
}
/** D:pWt 18983. */
function pWt(t: NodeJS.ProcessEnv): string { const e = IGe(t); return e !== undefined ? (t[e] ?? "") : ""; }
/** D:mWt 18987. */
function mWt(t: NodeJS.ProcessEnv, e: string): NodeJS.ProcessEnv {
  const r = IGe(t) ?? (process.platform === "win32" ? "Path" : "PATH"), n = { ...t };
  for (const s of Object.keys(n)) if (s !== r && s.toLowerCase() === "path") delete n[s];
  n[r] = e;
  return n;
}
const fWt = ["/usr/local/bin", "/usr/bin", "/bin"];
/** D:hWt 18994. */
function hWt(t: NodeJS.ProcessEnv, e: string): NodeJS.ProcessEnv {
  const r = path.dirname(e);
  if (!r || r === ".") return t;
  let n = pWt(t).split(path.delimiter).filter(Boolean);
  if (n.length === 0 && process.platform !== "win32") n = fWt;
  return mWt(t, [r, ...n.filter((o) => o !== r)].join(path.delimiter));
}
/**
 * D:b0 19002–19005: when Z2 is an absolute path, prepend its dir to PATH and set CURSOR_RIPGREP_PATH.
 * The original applies it to every Ko() spawn (D:21095: shell snapshot/commands); unconfigured → identity.
 */
export function b0(t: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return !Z2 || !path.isAbsolute(Z2) ? t : { ...hWt(t, Z2), CURSOR_RIPGREP_PATH: Z2 };
}

