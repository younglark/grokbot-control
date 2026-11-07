/** Public HTTPS only. Resolve once, reject reserved addresses, pin request DNS result.
 * No bearer/cookies, no redirects, standard TLS hostname/certificate validation.
 * Injected fetch functions (tests) are trusted SDK code, not a CLI bypass.
 */
import https from "node:https";
import dns from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";
import type { FetchFn } from "./attachments.js";
const deny = new BlockList(),
  deny6 = new BlockList(),
  global6 = new BlockList();
global6.addSubnet("2000::", 3, "ipv6");
for (const [ip, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["192.88.99.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  deny.addSubnet(ip, bits, "ipv4");
for (const [ip, bits] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["2001::", 23],
  ["2002::", 16],
] as const)
  deny6.addSubnet(ip, bits, "ipv6");
export function publicAddress(ip: string) {
  const family = isIP(ip);
  return (
    !!family &&
    (family !== 6 || global6.check(ip, "ipv6")) &&
    !(family === 4 ? deny : deny6).check(ip, family === 4 ? "ipv4" : "ipv6")
  );
}
export const publicHttpsFetch: FetchFn = async (value, init) => {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.hash ||
    (u.port && u.port !== "443")
  )
    throw new Error("download policy");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (init?.signal?.aborted) throw new Error("aborted");
  let listener: (() => void) | undefined;
  let choices: { address: string; family: number }[];
  try {
    choices = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await Promise.race([
          dns.lookup(host, { all: true }),
          new Promise<never>((_, reject) => {
            listener = () => reject(new Error("aborted"));
            init?.signal?.addEventListener("abort", listener, { once: true });
          }),
        ]);
  } finally {
    if (listener) init?.signal?.removeEventListener("abort", listener);
  }
  if (!choices.length || choices.some((c) => !publicAddress(c.address)))
    throw new Error("download policy");
  const chosen = choices[0];
  return await new Promise<Response>((resolve, reject) => {
    const headers = init?.headers as Record<string, string> | undefined;
    const req = https.request(
      u,
      {
        method: "GET",
        signal: init?.signal ?? undefined,
        headers,
        lookup: ((_name: string, opts: any, cb: any) =>
          opts?.all
            ? cb(null, [chosen])
            : cb(null, chosen.address, chosen.family)) as any,
      },
      (res) => {
        const status = res.statusCode ?? 500;
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers))
          if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(",") : v);
        const empty = status === 204 || status === 304;
        if (empty) res.resume();
        resolve(
          new Response(empty ? null : (Readable.toWeb(res) as ReadableStream), {
            status,
            headers: h,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
};
