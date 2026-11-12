import { type CliGlobal } from "./config.js";
import { type OutputMode } from "./io.js";
import { ControlPlane } from "../ops/plane.js";
export type DashboardStartData = {
    url: string;
    bind: {
        host: string;
        port: number;
    };
    opened: boolean;
};
/**
 * Local CLI command `gbc dashboard` / `gbc dashboard start`.
 * Not the official protobuf DashboardService. Starts a loopback, read-only
 * Bot monitor (poll + SSE). Does not interrupt remote Bots on shutdown.
 */
export declare function dashboardCommand(globals: CliGlobal, rest: string[], mode: OutputMode, plane: ControlPlane): Promise<number>;
export declare function assertDashboardVerb(verb: string): void;
