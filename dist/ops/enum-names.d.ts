/** Output name for a numeric value that the frozen schema does not define. */
export declare const UNKNOWN_ENUM_NAME = "unknown";
export type EnumNameTable = Readonly<Record<number, string>>;
/**
 * Build a number -> lower_snake name table from a generated enum. Names come from
 * the generated `localName` (prefix already stripped by protoc-gen-es), so the table
 * follows the frozen schema instead of a hand-copied list.
 */
export declare function enumNameTable(generated: any): EnumNameTable;
export declare const DELIVERY_NAMES: Readonly<Record<number, string>>;
export declare const SEND_STATUS_NAMES: Readonly<Record<number, string>>;
export declare const HARNESS_MODE_NAMES: Readonly<Record<number, string>>;
/** `{ name, code }` for a wire enum value; unknown numbers become "unknown" + the raw code. */
export declare function enumView(table: EnumNameTable, value: unknown): {
    name: string;
    code: number;
};
