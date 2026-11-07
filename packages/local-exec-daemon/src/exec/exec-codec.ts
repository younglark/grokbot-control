import type { JsonValue } from "@bufbuild/protobuf";
import {
  ExecClientControlMessage,
  ExecClientMessage,
  ExecServerMessage,
} from "../generated/agent.v1_pb";

/** Official handleExecRequest: kd.fromJsonString(..., { ignoreUnknownFields: true }). */
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
 * Encode outbound ExecClientMessage for messageJson.
 * Interim adapters that are not yet schema-shaped (notably ls listing) fall back
 * to the original object so behaviour is preserved; control frames must not.
 */
export function encodeExecClientMessageJson(message: Record<string, unknown>): string {
  try {
    return JSON.stringify(ExecClientMessage.fromJson(message as JsonValue).toJson());
  } catch {
    return JSON.stringify(message);
  }
}

/** Encode outbound ExecClientControlMessage (throw / streamClose / heartbeat). */
export function encodeExecClientControlMessageJson(message: Record<string, unknown>): string {
  return JSON.stringify(ExecClientControlMessage.fromJson(message as JsonValue).toJson());
}

export function isExecServerDecodeError(error: unknown): boolean {
  return error instanceof Error && /cannot decode .*ExecServerMessage/i.test(error.message);
}
