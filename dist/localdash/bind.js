import { GbcError } from "../errors.js";
export const DEFAULT_HOST = "127.0.0.1";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
export function isLoopbackHost(host) {
    const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
    if (LOOPBACK_HOSTS.has(h))
        return true;
    // 127.0.0.0/8
    const m = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
    return m;
}
export function parsePort(raw) {
    if (raw === undefined)
        return undefined;
    if (!/^\d+$/.test(raw)) {
        throw new GbcError("usage", `--port must be an integer 0..65535 (got: "${raw}")`, {
            exitCode: 2,
            hint: "gbc dashboard --port=8787  or  --port=0",
        });
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 65535) {
        throw new GbcError("usage", `--port must be an integer 0..65535 (got: "${raw}")`, {
            exitCode: 2,
            hint: "gbc dashboard --port=8787  or  --port=0",
        });
    }
    return n;
}
export function parseHost(raw) {
    if (raw === undefined || raw === "")
        return DEFAULT_HOST;
    const host = raw.trim();
    if (!isLoopbackHost(host)) {
        throw new GbcError("usage", `v1 refuses non-loopback --host ${host}; the local dashboard binds 127.0.0.1 by default`, {
            exitCode: 2,
            hint: "omit --host, or pass --host=127.0.0.1 / localhost / ::1",
        });
    }
    return host;
}
export function publicUrl(bind, sessionPath) {
    const host = bind.host.includes(":") && !bind.host.startsWith("[") ? `[${bind.host}]` : bind.host;
    const prefix = sessionPath.startsWith("/") ? sessionPath : `/${sessionPath}`;
    const path = prefix.endsWith("/") ? prefix : `${prefix}/`;
    return `http://${host}:${bind.port}${path}`;
}
export function allowedHostnames(bind) {
    const names = new Set();
    names.add("localhost");
    if (bind.ipv4) {
        names.add("127.0.0.1");
        names.add(bind.host.replace(/^\[|\]$/g, "").toLowerCase());
    }
    if (bind.ipv6) {
        names.add("::1");
        names.add("[::1]");
    }
    names.add(bind.host.replace(/^\[|\]$/g, "").toLowerCase());
    return names;
}
/** Extract hostname from a Host or Origin header value. */
export function headerHostname(value) {
    if (!value)
        return undefined;
    const raw = value.trim();
    if (!raw)
        return undefined;
    try {
        if (raw.startsWith("http://") || raw.startsWith("https://")) {
            return new URL(raw).hostname.toLowerCase();
        }
    }
    catch {
        return undefined;
    }
    // Host: hostname[:port] or [ipv6]:port
    if (raw.startsWith("[")) {
        const end = raw.indexOf("]");
        if (end > 1)
            return raw.slice(1, end).toLowerCase();
    }
    const host = raw.split(":")[0];
    return host ? host.toLowerCase() : undefined;
}
export function hostOriginAllowed(bind, hostHeader, originHeader) {
    const allowed = allowedHostnames(bind);
    const host = headerHostname(hostHeader);
    if (!host || !allowed.has(host))
        return false;
    if (originHeader) {
        const origin = headerHostname(originHeader);
        if (!origin || !allowed.has(origin))
            return false;
    }
    return true;
}
function classifyFamily(host) {
    const h = host.replace(/^\[|\]$/g, "");
    if (h === "::1")
        return { ipv4: false, ipv6: true };
    if (h === "localhost")
        return { ipv4: true, ipv6: false };
    return { ipv4: true, ipv6: false };
}
/**
 * Listen on host:port. If the requested port is busy (and is not 0), try the
 * next ports and return the address that actually bound.
 */
export async function listenOn(server, host, requestedPort, maxTries = 30) {
    const family = classifyFamily(host);
    const start = requestedPort;
    const attempts = start === 0 ? 1 : maxTries;
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        const port = start === 0 ? 0 : start + i;
        if (port > 65535)
            break;
        try {
            await new Promise((resolve, reject) => {
                const onErr = (err) => {
                    server.off("error", onErr);
                    reject(err);
                };
                server.once("error", onErr);
                server.listen({ host, port }, () => {
                    server.off("error", onErr);
                    resolve();
                });
            });
            const addr = server.address();
            if (!addr || typeof addr === "string") {
                throw new GbcError("error", "dashboard server bound but address() was empty");
            }
            return {
                host,
                port: addr.port,
                ipv4: family.ipv4 || addr.family === "IPv4",
                ipv6: family.ipv6 || addr.family === "IPv6",
            };
        }
        catch (e) {
            lastErr = e;
            const code = e.code;
            if (code !== "EADDRINUSE" && code !== "EACCES")
                throw e;
        }
    }
    throw new GbcError("error", `could not bind ${host}:${requestedPort}${requestedPort === 0 ? "" : " (and following ports)"}: ${String(lastErr)}`, { exitCode: 1 });
}
