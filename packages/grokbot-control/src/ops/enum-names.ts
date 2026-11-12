import { proto3 } from "@bufbuild/protobuf";
import {
  GrokBotSendStatus,
  GrokBotTemporalHarnessMode,
  GrokBotUserMessageDelivery,
} from "#proto-gen/aiserver";

/** Output name for a numeric value that the frozen schema does not define. */
export const UNKNOWN_ENUM_NAME = "unknown";

export type EnumNameTable = Readonly<Record<number, string>>;

/**
 * Build a number -> lower_snake name table from a generated enum. Names come from
 * the generated `localName` (prefix already stripped by protoc-gen-es), so the table
 * follows the frozen schema instead of a hand-copied list.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function enumNameTable(generated: any): EnumNameTable {
  const t = proto3.getEnumType(generated);
  const out: Record<number, string> = {};
  for (const v of t.values) out[v.no] = (v.localName ?? v.name).toLowerCase();
  return Object.freeze(out);
}

export const DELIVERY_NAMES = enumNameTable(GrokBotUserMessageDelivery);
export const SEND_STATUS_NAMES = enumNameTable(GrokBotSendStatus);
export const HARNESS_MODE_NAMES = enumNameTable(GrokBotTemporalHarnessMode);

/** `{ name, code }` for a wire enum value; unknown numbers become "unknown" + the raw code. */
export function enumView(table: EnumNameTable, value: unknown): { name: string; code: number } {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  const code = Number.isInteger(n) ? n : 0;
  return { name: table[code] ?? UNKNOWN_ENUM_NAME, code };
}
