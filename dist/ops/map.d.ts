import type { BotSummary, ProgressStatus, SessionSummary, SidebarSection } from "../dto/types.js";
/** int64 from protobuf JSON/TS may be bigint | string | number — normalize to string. */
export declare function int64ToString(v: unknown): string | undefined;
export declare function mapBot(a: any): BotSummary;
export declare function mapSection(s: any): SidebarSection;
export declare function mapSession(s: any): SessionSummary;
export declare function mapStatus(s: any): ProgressStatus;
