import { SyncOps } from "../sync/core.js";
import { createDashboardServiceClient, createGrokBotClient, createPlaneTransport, } from "../connect/client.js";
import { AuthOps } from "./auth.js";
import { BotOps } from "./bot.js";
import { ComputerOps } from "./computer.js";
import { MessageOps } from "./message.js";
import { ProgressOps } from "./progress.js";
import { SessionOps } from "./session.js";
import { SidebarOps } from "./sidebar.js";
import { UsageOps } from "./usage.js";
export class ControlPlane {
    client;
    sync;
    bot;
    message;
    session;
    progress;
    sidebar;
    auth;
    authOps;
    computer;
    /** Read-only GetSandUsageStatus / GetGrokBotUsageBreakdown wrapper; not a general official DashboardService facade. */
    usage;
    simulated;
    constructor(opts) {
        this.auth = opts.auth;
        this.simulated = Boolean(opts.simulated);
        const transport = createPlaneTransport(opts);
        this.client = createGrokBotClient({ ...opts, transport });
        // Sync keeps its own transport so the 16MiB decoded-response cap still applies.
        this.sync = new SyncOps(createGrokBotClient({ ...opts, readMaxBytes: 16 * 1024 * 1024 }), opts.baseUrl, this.simulated);
        const f = { simulated: this.simulated };
        this.authOps = new AuthOps(this.auth, f);
        this.bot = new BotOps(this.client, f);
        this.computer = new ComputerOps(this.client, f);
        this.message = new MessageOps(this.client, f);
        this.session = new SessionOps(this.client, f);
        this.progress = new ProgressOps(this.client, f);
        this.sidebar = new SidebarOps(this.client, f);
        // Official DashboardService client is constructed only to serve UsageOps.
        // Do not add CLI/MCP verbs or HTTP routes for other DashboardService RPCs here.
        this.usage = new UsageOps(createDashboardServiceClient({ ...opts, transport }), f);
    }
}
