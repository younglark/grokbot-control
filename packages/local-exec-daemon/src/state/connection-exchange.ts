import type { Connection } from "./connection";
import { describeError } from "../box/provider";

/**
 * O9r connection exchange (D:179117–179145): a plain HTTP JSON POST (the original uses fetch, not a proto RPC).
 */
export const CONNECTION_EXCHANGE_PATH = "/sand-box/local-exec-connection"; // D:k9r
export const NETWORK_TOKEN_HEADER = "x-anyrun-network-token"; // D:UDe 79877
export const PORT_TOKEN_HEADER = "x-anyrun-port-token"; // D:$De 79878
/** D:C9r / P9r (lee "SandLocalExecConnectionError"). */
export const BOX_IDLE_FOR_UC = "local-exec daemon serves the backend user-computer bridge; the box dial stays idle while the server credential is present";
export const BOX_NO_CONNECTION = "local-exec daemon has no gateway connection yet (waiting for the desktop to hand one off)";
export class SandLocalExecConnectionError extends Error { override name = "SandLocalExecConnectionError"; }

export type ExchangeResult =
  | { kind: "connected"; connection: Connection }
  | { kind: "unavailable"; reason: "transport" | "status" | "body" | "shape"; detail: string };

/** D:hb 79094 */
export class IsolatedDeploymentConfigError extends Error { override name = "IsolatedDeploymentConfigError"; }
/** D:KPe 79099: URL.parse(value ?? "") with an http(s) protocol, else null. */
function httpUrl(v: string | undefined): URL | null {
  const e = URL.parse(v ?? "");
  return e?.protocol === "https:" || e?.protocol === "http:" ? e : null;
}
/**
 * D:QPe 79103–79131 (validation part): SAND_ISOLATED_DEPLOYMENT !== "1" → not isolated. Otherwise the backend
 * (SAND_BACKEND_URL ?? CURSOR_API_BASE_URL) and website (SAND_CURSOR_WEBSITE_URL ?? CURSOR_WEBSITE_URL) must be http(s)
 * URLs or this throws. The returned `refuses` egress predicate is not used by the daemon paths ported here.
 */
export function validateIsolatedDeployment(env: NodeJS.ProcessEnv): boolean {
  if (env.SAND_ISOLATED_DEPLOYMENT !== "1") return false;
  if (httpUrl(env.SAND_BACKEND_URL ?? env.CURSOR_API_BASE_URL) == null)
    throw new IsolatedDeploymentConfigError("SAND_ISOLATED_DEPLOYMENT=1 needs SAND_BACKEND_URL or CURSOR_API_BASE_URL set to the deployment's http(s) backend");
  if (httpUrl(env.SAND_CURSOR_WEBSITE_URL ?? env.CURSOR_WEBSITE_URL) == null)
    throw new IsolatedDeploymentConfigError("SAND_ISOLATED_DEPLOYMENT=1 needs SAND_CURSOR_WEBSITE_URL or CURSOR_WEBSITE_URL set to the deployment's http(s) website");
  return true;
}

/** Backend client identity as eke(process.env, "desktop").backend (D:79157, jAt). */
export type BackendClient = { clientSource: string; clientVersion: string; boxNamespace: "dev" | "lab" | "prod"; clientOS: string };

/** D:jPe/LAt (78967–78972): x.y.z from the value, else from the bundled "0.79.3", else OAt "0.1.0". */
function baseVersion(v: string | undefined): string {
  const re = /^(\d+\.\d+\.\d+)(?:-.+)?$/;
  return re.exec(v?.trim() ?? "")?.[1] ?? re.exec("0.79.3")?.[1] ?? "0.1.0";
}
/** D:ese — namespace from SAND_BOX_OWNER_NAMESPACE, isolated deployment, and the variant. */
function namespaceOf(owner: string | undefined, variant: string, isolated: boolean): "dev" | "lab" | "prod" {
  const n = owner?.trim();
  if (n === "dev" || n === "lab") return n;
  if (isolated) return "prod";
  return variant === "sand-dev" ? "dev" : variant === "sand-lab" ? "lab" : "prod";
}
/** D:tse — SAND_PACKAGED / SAND_LAB → "sand" | "sand-lab" | "sand-dev". */
export function variantFromEnv(env: NodeJS.ProcessEnv = process.env): "sand" | "sand-lab" | "sand-dev" {
  return env.SAND_PACKAGED === "1" ? (env.SAND_LAB === "1" ? "sand-lab" : "sand") : "sand-dev";
}
/** D:HPe — namespace → Box/UC hello variant. */
export function variantForNamespace(ns: "dev" | "lab" | "prod"): string {
  return ns === "dev" ? "sand-dev" : ns === "lab" ? "sand-lab" : "sand";
}

/**
 * D:eke(env, "desktop").backend → jAt (79120–79140).
 * Isolated deployment = QPe(env) != null; QPe's startup URL validation is ported (validateIsolatedDeployment).
 */
export function backendClientFromEnv(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): BackendClient {
  const variant = variantFromEnv(env);
  const isolated = validateIsolatedDeployment(env);
  const versionNs = namespaceOf(env.SAND_BOX_OWNER_NAMESPACE, variant, false);
  const suffix = versionNs === "dev" ? "-dev" : versionNs === "lab" ? "-lab" : "";
  return {
    clientSource: "desktop",
    clientVersion: `${baseVersion(env.SAND_CLIENT_APP_VERSION)}${suffix}`, // D:VPe
    boxNamespace: namespaceOf(env.SAND_BOX_OWNER_NAMESPACE, variant, isolated),
    clientOS: platform,
  };
}

/** D:$At / FAt user-agent. */
function userAgent(c: BackendClient): string {
  const os = c.clientOS === "darwin" ? "(Macintosh; Intel Mac OS X 10_15_7)"
    : c.clientOS === "win32" ? "(Windows NT 10.0; Win64; x64)"
    : c.clientOS === "linux" ? "(X11; Linux x86_64)" : `(compatible; ${c.clientOS})`;
  return `Mozilla/5.0 ${os} AppleWebKit/537.36 (KHTML, like Gecko) Sand/${c.clientVersion} Safari/537.36`;
}
/** D:mb 79034–79044 (+ BAt clientSource mapping). */
export function clientHeaders(c: BackendClient): Record<string, string> {
  const h: Record<string, string> = {
    "user-agent": userAgent(c),
    "x-cursor-client-type": "sand", // D:kAt
    "x-cursor-client-version": c.clientVersion,
    "x-sand-box-namespace": c.boxNamespace,
    "x-cursor-client-os": c.clientOS,
  };
  const src = c.clientSource === "desktop" ? "sand-desktop" : c.clientSource === "box" || c.clientSource === "eval" ? undefined : c.clientSource;
  return src === undefined ? h : { ...h, "x-cursor-client-source": src };
}

/** D:M9r — networkToken wins over gatewayPortToken; neither → undefined. */
function tokenHeaders(networkToken: string, gatewayPortToken: string): Record<string, string> | undefined {
  if (networkToken.length > 0) return { [NETWORK_TOKEN_HEADER]: networkToken };
  if (gatewayPortToken.length > 0) return { [PORT_TOKEN_HEADER]: gatewayPortToken };
  return undefined;
}

/** D:O9r 179117–179145 */
export async function exchangeConnection(t: { backendUrl: string; credential: string; client: BackendClient; fetchImpl?: typeof fetch }): Promise<ExchangeResult> {
  const f = t.fetchImpl ?? fetch;
  const r = (reason: "transport" | "status" | "body" | "shape", detail: string): ExchangeResult => ({ kind: "unavailable", reason, detail });
  let n: Response;
  try {
    n = await f(new URL(CONNECTION_EXCHANGE_PATH, t.backendUrl).toString(), {
      method: "POST",
      headers: { "content-type": "application/json", ...clientHeaders(t.client) },
      body: JSON.stringify({ credential: t.credential }),
    });
  } catch (l) { return r("transport", describeError(l)); }
  if (!n.ok) return r("status", `http_${n.status}`);
  let s: unknown;
  try { s = await n.json(); } catch (l) { return r("body", describeError(l)); }
  if (!(typeof s === "object" && s !== null && !Array.isArray(s))) return r("shape", "reply is not an object"); // D:Ke
  const o = s as Record<string, unknown>;
  const baseUrl = typeof o.baseUrl === "string" ? o.baseUrl : "";
  if (baseUrl.length === 0) return r("shape", "reply has no baseUrl");
  const token = typeof o.token === "string" && o.token.length > 0 ? o.token : undefined;
  const a = typeof o.networkToken === "string" ? o.networkToken : "";
  const u = typeof o.gatewayPortToken === "string" ? o.gatewayPortToken : "";
  // The original object literal keeps token/headers keys even when undefined; JSON.stringify in vLe drops them.
  return { kind: "connected", connection: { baseUrl, token, headers: tokenHeaders(a, u) } as Connection };
}
