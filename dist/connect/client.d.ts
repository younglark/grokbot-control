import { ConnectError } from "@connectrpc/connect";
import type { Interceptor, Transport } from "@connectrpc/connect";
import type { AuthProvider } from "../auth/types.js";
import { GbcError } from "../errors.js";
/**
 * Generated Connect client. Typed loosely because vendored JS ServiceType
 * lacks full TS generics; runtime methods match GrokBotService.
 */
export type GrokBotClient = any;
export type ConnectConfig = {
    baseUrl: string;
    auth?: AuthProvider;
    transport?: Transport;
    /** Optional transport decoded-response cap (sync uses 16MiB). */
    readMaxBytes?: number;
};
/**
 * Project read-only unary RPCs eligible for at most one 401 refresh+retry.
 * Writes are never retried. Membership is by Connect method name (PascalCase),
 * never by HTTP verb alone.
 */
export declare const READ_ONLY_UNARY_METHODS: Set<string>;
/** Carry GbcError through Connect as `cause` so ops can restore structured codes. */
export declare function gbcAsConnect(gbc: GbcError): ConnectError;
export declare function unwrapGbcCause(err: unknown): GbcError | undefined;
export declare function createAuthInterceptor(auth: AuthProvider): Interceptor;
/**
 * Shared Connect transport for GrokBotService and the official DashboardService
 * stub. Callers should construct this once and pass the same `transport` into
 * both clients so interceptors (auth / 401 retry) are not duplicated.
 */
export declare function createPlaneTransport(cfg: ConnectConfig): Transport;
export declare function createGrokBotClient(cfg: ConnectConfig): GrokBotClient;
/**
 * Official `aiserver.v1.DashboardService` Connect client (generated stub).
 * This is not the local CLI command `gbc dashboard`. The official service has
 * many write RPCs (Set*, ExecuteSandMcpTool, CancelSandTrial, SendTeamInvite,
 * etc.). Callers must wrap only explicitly approved read RPCs and must never
 * expose official write RPCs via CLI, MCP, or HTTP — even if the process was
 * started with `--allow-writes`.
 */
export type DashboardServiceClient = any;
export declare function createDashboardServiceClient(cfg: ConnectConfig): DashboardServiceClient;
export type MapErrorOpts = {
    /** True when the RPC is a mutation (create/update/delete/send/sidebar write/interrupt). */
    write?: boolean;
};
export declare function mapConnectError(err: unknown, requestId: string, opts?: MapErrorOpts): GbcError;
