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
export declare function createGrokBotClient(cfg: ConnectConfig): GrokBotClient;
export type MapErrorOpts = {
    /** True when the RPC is a mutation (create/update/delete/send/sidebar write/interrupt). */
    write?: boolean;
};
export declare function mapConnectError(err: unknown, requestId: string, opts?: MapErrorOpts): GbcError;
