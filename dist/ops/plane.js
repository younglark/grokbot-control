import { SyncOps } from "../sync/core.js";
import { createGrokBotClient } from "../connect/client.js";
import { AuthOps } from "./auth.js";
import { BotOps } from "./bot.js";
import { ComputerOps } from "./computer.js";
import { MessageOps } from "./message.js";
import { ProgressOps } from "./progress.js";
import { SessionOps } from "./session.js";
import { SidebarOps } from "./sidebar.js";
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
    simulated;
    constructor(opts) {
        this.auth = opts.auth;
        this.simulated = Boolean(opts.simulated);
        this.client = createGrokBotClient(opts);
        this.sync = new SyncOps(createGrokBotClient({ ...opts, readMaxBytes: 16 * 1024 * 1024 }), opts.baseUrl, this.simulated);
        const f = { simulated: this.simulated };
        this.authOps = new AuthOps(this.auth, f);
        this.bot = new BotOps(this.client, f);
        this.computer = new ComputerOps(this.client, f);
        this.message = new MessageOps(this.client, f);
        this.session = new SessionOps(this.client, f);
        this.progress = new ProgressOps(this.client, f);
        this.sidebar = new SidebarOps(this.client, f);
    }
}
