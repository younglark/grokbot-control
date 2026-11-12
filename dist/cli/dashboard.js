import { flag, hasFlag } from "./config.js";
import { emitResult, writeErrJson } from "./io.js";
import { okResult } from "../dto/result.js";
import { GbcError } from "../errors.js";
import { parseHost, parsePort } from "../localdash/bind.js";
import { openInBrowser } from "../localdash/open.js";
import { startDashboardServer } from "../localdash/server.js";
/**
 * Local CLI command `gbc dashboard` / `gbc dashboard start`.
 * Not the official protobuf DashboardService. Starts a loopback, read-only
 * Bot monitor (poll + SSE). Does not interrupt remote Bots on shutdown.
 */
export async function dashboardCommand(globals, rest, mode, plane) {
    const host = parseHost(flag(rest, "--host"));
    const port = parsePort(flag(rest, "--port")) ?? 8787;
    const noOpen = hasFlag(rest, "--no-open");
    const started = await startDashboardServer({ plane, host, port });
    // Register SIGINT/SIGTERM before printing the ready URL so a client that
    // disconnects immediately still gets the documented exit 0 and a clean close.
    const exiting = waitForSignal(() => started.close());
    let opened = false;
    if (!noOpen) {
        const result = await openInBrowser(started.url);
        opened = result.ok;
        if (!result.ok) {
            writeErrJson({
                event: "open_browser_failed",
                url: started.url,
                error: result.error,
                hint: "open the printed URL manually; the server is still running",
            });
        }
    }
    const data = {
        url: started.url,
        bind: { host: started.bind.host, port: started.bind.port },
        opened,
    };
    if (mode.plain) {
        // Special case: --plain is the raw URL, not JSON-quoted and not the data object.
        process.stdout.write(data.url.endsWith("\n") ? data.url : data.url + "\n");
    }
    else {
        emitResult(okResult(data, { simulated: plane.simulated }), mode);
    }
    return await exiting;
}
function waitForSignal(onStop) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = async () => {
            if (settled)
                return;
            settled = true;
            process.off("SIGINT", onSig);
            process.off("SIGTERM", onSig);
            try {
                await onStop();
            }
            catch {
                /* still exit 0: do not interrupt remote Bots */
            }
            resolve(0);
        };
        const onSig = () => {
            void finish();
        };
        process.once("SIGINT", onSig);
        process.once("SIGTERM", onSig);
    });
}
export function assertDashboardVerb(verb) {
    if (verb !== "start") {
        throw new GbcError("usage", `unknown command: dashboard ${verb}`, {
            exitCode: 2,
            hint: "gbc dashboard  or  gbc dashboard start  [--port] [--host] [--no-open]",
        });
    }
}
