import http from "node:http";
import type { ControlPlane } from "../ops/plane.js";
import { type BindTarget } from "./bind.js";
import { DashboardPoller, type DashboardPollerOptions } from "./poller.js";
export type DashboardServerOptions = {
    plane: ControlPlane;
    host?: string;
    port?: number;
    /** Override static UI root (tests). */
    uiRoot?: string;
    /** Override session token (tests). */
    sessionToken?: string;
    /** Test-only poll interval overrides. */
    poller?: DashboardPollerOptions;
};
export type StartedDashboard = {
    url: string;
    bind: BindTarget;
    sessionPath: string;
    server: http.Server;
    poller: DashboardPoller;
    close: () => Promise<void>;
};
/**
 * Local `gbc dashboard` HTTP+SSE server. Independent of official DashboardService
 * write RPCs: this process only serves the packed UI and read-only frames.
 */
export declare function startDashboardServer(opts: DashboardServerOptions): Promise<StartedDashboard>;
export declare function resolveDashboardUiRoot(): string | undefined;
export declare function newSessionToken(): string;
