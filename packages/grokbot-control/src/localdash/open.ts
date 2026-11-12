import { spawn } from "node:child_process";

/**
 * Open a local URL with the platform browser helper.
 * `gbc auth login` only writes an event to stderr and does not actually open a
 * browser; the local dashboard command does this itself.
 */
export function openInBrowser(url: string): Promise<{ ok: boolean; error?: string }> {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.on("error", (err) => resolve({ ok: false, error: err.message }));
      child.once("exit", (code) => {
        if (code && code !== 0) resolve({ ok: false, error: `${cmd} exited ${code}` });
        else resolve({ ok: true });
      });
      child.unref();
      // `open` / `xdg-open` may daemonize before exiting; treat spawn success as ok
      // if it stays running briefly without error.
      setTimeout(() => resolve({ ok: true }), 500);
    } catch (e) {
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}
