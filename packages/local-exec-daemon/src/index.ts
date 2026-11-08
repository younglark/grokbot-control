#!/usr/bin/env node
import { shutdownShells } from "./exec/handlers";
import { readJsonIfExists, dataRootFromEnv } from "./util";
import * as os from "node:os";
import * as path from "node:path";
import { awaitHandoff, exitFatal } from "./bootstrap/handoff";
import { loadSettings } from "./settings";
import { clearDiscovery, isSupervised, loadDiscovery, publishDiscovery } from "./state/discovery";
import { loadConnection } from "./state/connection";
import { BoxProvider } from "./box/provider";
import { UserComputerProvider } from "./uc/provider";
import { loadSealedCredential, pickUserComputerChannel } from "./uc/credential";
import {
  generationFromEnv,
  loadLease,
  ownershipDecision,
  pidAlive,
} from "./state/lease";
import { localRootFromEnv, logInfo, delay } from "./util";

async function main(): Promise<void> {
  const startedAt = Date.now();
  const handoff = await awaitHandoff(5000);
  if (!handoff.ok) exitFatal();

  const { key, computerId } = handoff.handoff;
  const root = path.resolve(localRootFromEnv());
  const { permission } = await loadSettings();
  const generation = generationFromEnv();

  let servingAt: number | undefined;
  let inflightCount = 0;
  let box: BoxProvider | undefined;
  let uc: UserComputerProvider | undefined;
  let shuttingDown = false;

  let publishChain: Promise<void> = Promise.resolve();
  const publish = () => {
    publishChain = publishChain
      .then(() =>
        publishDiscovery(
          {
            pid: process.pid,
            startedAt,
            servingAt,
            inflightCount,
            ...(generation !== undefined ? { generation } : {}),
          },
          key,
        ),
      )
      .catch(() => undefined);
    return publishChain;
  };

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logInfo(`received ${signal}, shutting down`);
    try {
      // Transports are drained after process-group cleanup below.
    } catch {
      /* ignore */
    }
    void (async () => {
      try {
        uc?.beginShutdown(); box?.beginShutdown();
        await shutdownShells();
        await Promise.all([box?.stop(), uc?.stop()]);
      } catch {
        /* ignore */
      }
      await publishChain;
      await clearDiscovery();
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await publish();

  const inflightByTransport = { box: 0, uc: 0 };
  const onInflight = (transport: "box" | "uc", n: number) => {
    inflightByTransport[transport] = n;
    inflightCount = inflightByTransport.box + inflightByTransport.uc;
    void publish();
  };

  const tryStartBox = async () => {
    if (box || shuttingDown) return;
    const conn = await loadConnection();
    if (!conn) return;
    box = new BoxProvider({
      connection: conn,
      root,
      computerId,
      label: os.hostname() || "local-exec-daemon",
      variant: process.env.SAND_VARIANT || "sand-dev",
      permission,
      onInflight: n => onInflight("box", n),
    });
    servingAt = Date.now();
    await publish();
    void box.start().catch(() => undefined);
  };

  let ucRecreating = false;
  const tryStartUc = async () => {
    if (shuttingDown || ucRecreating) return;
    const payload = await loadSealedCredential(key);
    if (!payload) return;
    const ch = pickUserComputerChannel(payload);
    if (!ch) return;
    if (uc) {
      // Official (D:L179352): a serverAuthoritative change in either direction closes the provider and
      // creates a new one; it is never flipped in place.
      if (uc.serverAuthoritative === (ch.serverAuthoritative === true)) { uc.updateChannel(ch); return; }
      if (ucRecreating) return;
      ucRecreating = true;
      const old = uc;
      try { uc = undefined; await old.stop(); } finally { ucRecreating = false; }
      if (shuttingDown) return;
    }
    const provider = new UserComputerProvider({
      backendUrl: ch.backendUrl,
      machineId: ch.machineId || computerId,
      credential: ch.credential,
      accountScope: ch.accountScope,
      root,
      permission,
      hello: {
        label: os.hostname() || "local-exec-daemon",
        localRoot: root,
        terminalsFolder: path.join(root, "terminals"),
        standing: permission === "always" ? "always" : permission === "never" ? "never" : "ask",
        variant: process.env.SAND_VARIANT || "sand-dev",
        serverAuthoritative: ch.serverAuthoritative ?? false,
        capabilities: {
          aiToolSetup: false,
          messagesOpGeneration: 4,
        },
      },
      onInflight: n => onInflight("uc", n),
    });
    uc = provider;
    servingAt = Date.now();
    await publish();
    // start owns reconnects; a Watch connection ending is NOT provider shutdown.
    void provider.start().catch(() => console.error("[user-computer-provider] provider lifecycle failed"));
  };

  for (let i = 0; i < 50 && !box && !uc && !shuttingDown; i++) {
    await tryStartBox();
    await tryStartUc();
    if (!box && !uc) await delay(100);
  }

  logInfo(`started (pid ${process.pid}); serving local exec over the gateway`);

  // Keep process alive while serving (do not unref).
  setInterval(() => {
    void tryStartBox().catch(() => undefined);
    void tryStartUc().catch(() => undefined);
  }, 1000);

  // Ownership tick: supervisor/lease + discovery PID superseded (official FDe/Jae/hce).
  // Generation is published into discovery from env; daemon does not compare generations.
  let supersededSinceMs: number | undefined;
  setInterval(() => {
    void (async () => {
      if (shuttingDown) return;
      const supervised = await isSupervised();
      const lease = await loadLease();
      const hb = await readJsonIfExists<{at: number}>(path.join(dataRootFromEnv(), "local-exec-supervisor.json"));
      const staleFor = Date.now() - (hb?.at ?? startedAt) - 90_000;
      const disc = await loadDiscovery();
      if (disc && disc.pid !== process.pid && pidAlive(disc.pid)) {
        supersededSinceMs ??= Date.now();
      } else {
        if (disc && disc.pid !== process.pid) await publish();
        supersededSinceMs = undefined;
      }
      const supersededForMs = supersededSinceMs == null ? null : Date.now() - supersededSinceMs;
      if (
        ownershipDecision({
          supervisedFresh: supervised,
          lease,
          inflightCount,
          supervisorStaleForMs: staleFor,
          supersededForMs,
        }) === "exit"
      ) {
        shutdown(supersededSinceMs != null ? "superseded" : "unsupervised");
      }
    })().catch(() => shutdown("ownership-state-error"));
  }, 2000).unref();
}

main().catch(() => exitFatal());
