import type { JsonValue } from "@bufbuild/protobuf";
import {
  ExecClientControlMessage,
  ExecClientMessage,
  ExecServerMessage,
} from "../generated/agent.v1_pb";
import type { ExecFrameOut } from "./handlers";

/**
 * Official handleExecRequest (daemon.formatted.cjs L136313):
 *   kd.fromJsonString(e.serverMessageJson, { ignoreUnknownFields: !0 })
 */
export const EXEC_JSON_READ = { ignoreUnknownFields: true } as const;

/**
 * Decode inner ExecServerMessage from the UC/box JSON string payload.
 * Protobuf-es already prefixes failures with
 * `cannot decode agent.v1.ExecServerMessage from JSON: ...` (matches official oracle text).
 */
export function decodeExecServerMessageJson(serverMessageJson: string): ExecServerMessage {
  return ExecServerMessage.fromJsonString(serverMessageJson, EXEC_JSON_READ);
}

/** Decode an already-parsed JSON object (box SSE path). */
export function decodeExecServerMessageValue(value: JsonValue): ExecServerMessage {
  return ExecServerMessage.fromJson(value, EXEC_JSON_READ);
}

/** Plain object for existing dispatchExec adapters (camelCase JSON names). */
export function execServerMessageToRecord(msg: ExecServerMessage): Record<string, unknown> {
  return msg.toJson() as Record<string, unknown>;
}

/**
 * Detect legacy interim ls `{ success: { path, entries } }` (pre-directory_tree_root).
 * Production encode no longer falls back; kept for regressions that assert rejection.
 */
export function isInterimLsListingMessage(message: Record<string, unknown>): boolean {
  const lsResult = message.lsResult;
  if (lsResult === null || typeof lsResult !== "object" || Array.isArray(lsResult)) return false;
  const success = (lsResult as Record<string, unknown>).success;
  if (success === null || typeof success !== "object" || Array.isArray(success)) return false;
  const s = success as Record<string, unknown>;
  const hasEntries = Array.isArray(s.entries);
  const hasTree = s.directoryTreeRoot != null || s.directory_tree_root != null;
  return hasEntries && !hasTree;
}

/** Normalize outbound ExecClientMessage (strict schema encode; no interim fallback). */
export function encodeExecClientMessage(message: Record<string, unknown>): Record<string, unknown> {
  return ExecClientMessage.fromJson(message as JsonValue).toJson() as Record<string, unknown>;
}

export function encodeExecClientMessageJson(message: Record<string, unknown>): string {
  return JSON.stringify(encodeExecClientMessage(message));
}

/** Normalize outbound ExecClientControlMessage (throw / streamClose / heartbeat). */
export function encodeExecClientControlMessage(message: Record<string, unknown>): Record<string, unknown> {
  return ExecClientControlMessage.fromJson(message as JsonValue).toJson() as Record<string, unknown>;
}

export function encodeExecClientControlMessageJson(message: Record<string, unknown>): string {
  return JSON.stringify(encodeExecClientControlMessage(message));
}

/**
 * Box outer envelope stays `{ kind, requestId, message, ... }`; only the inner
 * `message` object is schema-normalized (same codec as UC messageJson).
 */
export function prepareBoxExecFrame(frame: ExecFrameOut): Record<string, unknown> {
  if (frame.kind === "client") {
    return { kind: "client", requestId: frame.requestId, message: encodeExecClientMessage(frame.message) };
  }
  if (frame.kind === "control") {
    const out: Record<string, unknown> = {
      kind: "control",
      requestId: frame.requestId,
      message: encodeExecClientControlMessage(frame.message),
    };
    if (frame.cwdState !== undefined) out.cwdState = frame.cwdState;
    return out;
  }
  return { kind: frame.kind, requestId: frame.requestId, error: frame.error };
}

export function isExecServerDecodeError(error: unknown): boolean {
  return error instanceof Error && /cannot decode .*ExecServerMessage/i.test(error.message);
}
