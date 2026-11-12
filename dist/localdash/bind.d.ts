import type { Server } from "node:http";
export declare const DEFAULT_HOST = "127.0.0.1";
export type BindTarget = {
    host: string;
    port: number;
    /** True when an IPv4 loopback address is bound. */
    ipv4: boolean;
    /** True when an IPv6 loopback address is bound. */
    ipv6: boolean;
};
export declare function isLoopbackHost(host: string): boolean;
export declare function parsePort(raw: string | undefined): number | undefined;
export declare function parseHost(raw: string | undefined): string;
export declare function publicUrl(bind: BindTarget, sessionPath: string): string;
export declare function allowedHostnames(bind: BindTarget): Set<string>;
/** Extract hostname from a Host or Origin header value. */
export declare function headerHostname(value: string | undefined): string | undefined;
export declare function hostOriginAllowed(bind: BindTarget, hostHeader: string | undefined, originHeader: string | undefined): boolean;
/**
 * Listen on host:port. If the requested port is busy (and is not 0), try the
 * next ports and return the address that actually bound.
 */
export declare function listenOn(server: Server, host: string, requestedPort: number, maxTries?: number): Promise<BindTarget>;
