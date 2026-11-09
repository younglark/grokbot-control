import * as crypto from "node:crypto";
import * as http from "node:http";

/**
 * D:gb 79197 / HAt 79198 / VAt 79211 / nke 79217–79232, run at daemon module load by sqr (D:187195–187207):
 * the App's coordinator passes `SAND_NODE_PROXY_ENV` (coordinator 66932, raw JSON of {HTTPS_PROXY, HTTP_PROXY,
 * NO_PROXY}) only when system-proxy mode is on. The daemon removes it from process.env, applies it with
 * `http.setGlobalProxyFromEnv({...})` (Node's built-in proxy for http/https and fetch), and publishes the
 * 16-hex sha256 fingerprint in discovery (D:179216) so the coordinator can adopt/replace (Pce 66625).
 */
export const NODE_PROXY_ENV = "SAND_NODE_PROXY_ENV";
type ProxyEnv = { HTTPS_PROXY: string; HTTP_PROXY: string; NO_PROXY: string };

function parse(raw: string | undefined): ProxyEnv | undefined {
  if (raw === undefined) return undefined;
  let e: unknown;
  try { e = JSON.parse(raw); } catch { return undefined; }
  if (e === null || typeof e !== "object" || Array.isArray(e)) return undefined; // D:Ke
  const { HTTPS_PROXY: r, HTTP_PROXY: n, NO_PROXY: s } = e as Record<string, unknown>;
  if (!(typeof r !== "string" || typeof n !== "string") && typeof s === "string") return { HTTPS_PROXY: r, HTTP_PROXY: n, NO_PROXY: s };
  return undefined;
}
export function proxyFingerprint(p: ProxyEnv): string {
  return crypto.createHash("sha256").update(JSON.stringify([p.HTTPS_PROXY, p.HTTP_PROXY, p.NO_PROXY])).digest("hex").slice(0, 16);
}
function describe(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export function applyNodeProxyEnv(
  env: NodeJS.ProcessEnv = process.env,
  log: (m: string) => void = m => console.error(`[local-exec-daemon] ${m}`), // D:_c 179152
  apply: (p: ProxyEnv) => void = p => (http as unknown as { setGlobalProxyFromEnv: (e: Record<string, string>) => void }).setGlobalProxyFromEnv({ ...p }),
): { raw: string; fingerprint: string } | undefined {
  const n = env[NODE_PROXY_ENV];
  delete env[NODE_PROXY_ENV];
  if (n === undefined) return undefined;
  const s = parse(n);
  if (s === undefined) { log(`${NODE_PROXY_ENV} is malformed; staying direct`); return undefined; }
  try { apply(s); } catch (o) { log(`${NODE_PROXY_ENV} was refused (${describe(o)}); staying direct`); return undefined; }
  return { raw: n, fingerprint: proxyFingerprint(s) };
}
