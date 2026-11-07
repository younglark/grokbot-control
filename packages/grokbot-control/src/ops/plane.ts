import { SyncOps } from "../sync/core.js";
import type { AuthProvider } from "../auth/types.js";
import { createGrokBotClient, type ConnectConfig, type GrokBotClient } from "../connect/client.js";
import { AuthOps } from "./auth.js";
import { BotOps } from "./bot.js";
import { MessageOps } from "./message.js";
import { ProgressOps } from "./progress.js";
import { SessionOps } from "./session.js";
import { SidebarOps } from "./sidebar.js";

export type ControlPlaneOptions = ConnectConfig & {
  /** Marks all results as simulated (mock/in-memory). */
  simulated?: boolean;
};

export class ControlPlane {
  readonly client: GrokBotClient;
  readonly sync: SyncOps;
  readonly bot: BotOps;
  readonly message: MessageOps;
  readonly session: SessionOps;
  readonly progress: ProgressOps;
  readonly sidebar: SidebarOps;
  readonly auth?: AuthProvider;
  readonly authOps: AuthOps;
  readonly simulated: boolean;

  constructor(opts: ControlPlaneOptions) {
    this.auth = opts.auth;
    this.simulated = Boolean(opts.simulated);
    this.client = createGrokBotClient(opts);
    this.sync = new SyncOps(createGrokBotClient({ ...opts, readMaxBytes: 16 * 1024 * 1024 }), opts.baseUrl, this.simulated);
    const f = { simulated: this.simulated };
    this.authOps = new AuthOps(this.auth, f);
    this.bot = new BotOps(this.client, f);
    this.message = new MessageOps(this.client, f);
    this.session = new SessionOps(this.client, f);
    this.progress = new ProgressOps(this.client, f);
    this.sidebar = new SidebarOps(this.client, f);
  }
}
