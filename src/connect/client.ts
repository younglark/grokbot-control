import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import type { Interceptor, Transport } from "@connectrpc/connect";
import { GrokBotService } from "#proto-gen/GrokBotService";
import type { AuthProvider } from "../auth/types.js";
import { GbcError } from "../errors.js";

/**
 * Generated Connect client. Typed loosely because vendored JS ServiceType
 * lacks full TS generics; runtime methods match GrokBotService.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GrokBotClient = any;

export type ConnectConfig = {
  baseUrl: string;
  auth?: AuthProvider;
  transport?: Transport;
};

export function createAuthInterceptor(auth: AuthProvider): Interceptor {
  return (next) => async (req) => {
    const token = await auth.getAccessToken();
    if (token) req.header.set("authorization", `Bearer ${token}`);
    return next(req);
  };
}

export function createGrokBotClient(cfg: ConnectConfig): GrokBotClient {
  const interceptors: Interceptor[] = [];
  if (cfg.auth) interceptors.push(createAuthInterceptor(cfg.auth));
  const transport =
    cfg.transport ??
    createConnectTransport({
      baseUrl: cfg.baseUrl.replace(/\/$/, ""),
      httpVersion: "1.1",
      interceptors,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createClient(GrokBotService as any, transport);
}

export function mapConnectError(err: unknown, requestId: string): GbcError {
  const anyErr = err as {
    code?: string | number;
    rawMessage?: string;
    message?: string;
    name?: string;
  };
  const msg = anyErr.rawMessage || anyErr.message || String(err);
  const codeStr = String(anyErr.code ?? "");

  if (
    anyErr.name === "AbortError" ||
    /fetch failed|ECONNRESET|socket hang up|network/i.test(msg)
  ) {
    return new GbcError("unknown", `transport ended without a known outcome: ${msg}`, {
      outcome: "unknown",
      retryable: false,
      exitCode: 10,
      hint: "Do not blindly resend create/send/delete. Reconcile with list/get_send_status/history.",
      details: { request_id: requestId },
    });
  }

  switch (codeStr) {
    case "unauthenticated":
    case "16":
      return new GbcError("unauthenticated", msg, { exitCode: 4 });
    case "not_found":
    case "5":
      return new GbcError("not_found", msg, { exitCode: 5 });
    case "already_exists":
    case "aborted":
    case "6":
    case "10":
      return new GbcError("conflict", msg, { exitCode: 6 });
    case "permission_denied":
    case "7":
      return new GbcError("permission_denied", msg, { exitCode: 7 });
    case "failed_precondition":
    case "9":
      return new GbcError("failed_precondition", msg, {
        exitCode: 7,
        hint: "May indicate sidebar_sections_base conflict — re-read and retry patch.",
      });
    case "unavailable":
    case "14":
      return new GbcError("unavailable", msg, { retryable: true, exitCode: 8 });
    case "deadline_exceeded":
    case "4":
      return new GbcError("deadline_exceeded", msg, {
        outcome: "unknown",
        retryable: false,
        exitCode: 10,
        hint: "Deadline without response: treat write as unknown; reconcile; do not auto-replay.",
      });
    case "canceled":
    case "1":
      return new GbcError("canceled", msg, {
        outcome: "unknown",
        retryable: false,
        exitCode: 10,
        hint: "Request canceled ≠ InterruptGrokBotAgentRun.",
      });
    case "invalid_argument":
    case "3":
      return new GbcError("invalid_argument", msg, { exitCode: 2 });
    default:
      return new GbcError("rpc_error", msg, { exitCode: 9, details: { code: codeStr } });
  }
}
