import { SyncOps } from "../sync/core.js";
import type { AuthProvider } from "../auth/types.js";
import { type ConnectConfig, type GrokBotClient } from "../connect/client.js";
import { AuthOps } from "./auth.js";
import { BotOps } from "./bot.js";
import { AccountCleanupOps } from "./account.js";
import { ComputerOps } from "./computer.js";
import { MessageOps } from "./message.js";
import { ProgressOps } from "./progress.js";
import { SessionOps } from "./session.js";
import { SidebarOps } from "./sidebar.js";
import { UsageOps } from "./usage.js";
export type ControlPlaneOptions = ConnectConfig & {
    /** Marks all results as simulated (mock/in-memory). */
    simulated?: boolean;
};
export declare class ControlPlane {
    readonly client: GrokBotClient;
    readonly sync: SyncOps;
    readonly bot: BotOps;
    readonly message: MessageOps;
    readonly session: SessionOps;
    readonly progress: ProgressOps;
    readonly sidebar: SidebarOps;
    readonly auth?: AuthProvider;
    readonly authOps: AuthOps;
    readonly computer: ComputerOps;
    readonly account: AccountCleanupOps;
    /** Read-only GetSandUsageStatus / GetGrokBotUsageBreakdown wrapper; not a general official DashboardService facade. */
    readonly usage: UsageOps;
    readonly simulated: boolean;
    constructor(opts: ControlPlaneOptions);
}
