import { z } from "zod";
import type { ControlPlane } from "../ops/plane.js";
import type { ResultEnvelope } from "../dto/result.js";
export type ToolDef = {
    name: string;
    description: string;
    inputSchema: z.ZodObject<any>;
    /** Does not mutate Grok Bot server state (safe in read-only toolsets). */
    readOnly?: boolean;
    /** Local auth-state tool (changes only this tool's own credential files). */
    authTool?: boolean;
    handler: (plane: ControlPlane, args: Record<string, unknown>) => Promise<ResultEnvelope>;
};
export declare function toolAnnotations(t: {
    name: string;
    readOnly?: boolean;
    authTool?: boolean;
}): {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
} | {
    readOnlyHint: true;
    openWorldHint: boolean;
    destructiveHint?: undefined;
    idempotentHint?: undefined;
} | {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
    idempotentHint?: undefined;
};
export type SyncToolConfig = {
    root: string;
    allowLocalWrites?: boolean;
    accountId?: string;
    teamId?: string;
    acknowledgeUnverifiedScope?: boolean;
};
export declare function buildTools(opts?: {
    /** Hide auth-mutating tools as well as writes (GBT_MCP_READONLY=1). */
    readOnly?: boolean;
    /** When false/undefined, write tools are not registered (default). */
    allowWrites?: boolean;
    sync?: SyncToolConfig;
}): ToolDef[];
