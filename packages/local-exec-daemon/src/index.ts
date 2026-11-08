#!/usr/bin/env node
import { lifecycleTrace } from "./trace";
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

  // D:L179193–179239: pending/running coalesce requests; T tracks the running publication.
  // The ownership latch A suppresses new writes until the ownership tick clears it.
  let supersededSinceMs: number | undefined;
  let publishPending = false;
  let publishRunning = false;
  let publishTask: Promise<void> | undefined;
  let publishId = 0;
  const flushDiscovery = async (): Promise<void> => {
    try {
      while (publishPending) {
        publishPending = false;
        if (supersededSinceMs !== undefined) return;
        const discovery = await loadDiscovery();
        const otherAlive = !!discovery && discovery.pid !== process.pid && pidAlive(discovery.pid);
        lifecycleTrace("publish:guard", { owner: discovery?.pid, otherAlive, shuttingDown });
        if (otherAlive || shuttingDown) return;
        // Original has no post-read CAS: an already-started write can finish after ownership changes.
        let written = true;
        await publishDiscovery(
          {
            pid: process.pid,
            startedAt,
            servingAt,
            inflightCount,
            ...(generation !== undefined ? { generation } : {}),
          },
          key,
        ).catch(error => { written = false; lifecycleTrace("publish:error", { kind: error?.name }); });
        if (written) lifecycleTrace("publish:done");
      }
    } finally {
      publishRunning = false;
    }
  };
  const publish = async (): Promise<void> => {
    lifecycleTrace("publish:request", { id: ++publishId, shuttingDown });
    if (shuttingDown) return;
    publishPending = true;
    if (publishRunning) return; // Busy C returns immediately; close separately awaits T.
    publishRunning = true;
    const task = flushDiscovery();
    publishTask = task;
    try {
      await task;
    } finally {
      if (publishTask === task) publishTask = undefined;
    }
  };

  // D:yre/hc L78435–78587: next cadence is anchored at completion, not at a wall-clock interval.
  // Poke during a tick coalesces into one immediate follow-up; shutdown disposes cadence and awaits w.
  let ucRefresh: Promise<void> | undefined;
  let ucFollowUp = false;
  let ucRefreshTimer: NodeJS.Timeout | undefined;
  let ucCadenceStarted = false;
  const requestUcRefresh = (): void => {
    if (shuttingDown) return;
    if (ucRefresh !== undefined) { ucFollowUp = true; return; }
    clearTimeout(ucRefreshTimer);
    ucRefreshTimer = undefined;
    ucRefresh = Promise.resolve().then(async () => {
      do {
        ucFollowUp = false;
        lifecycleTrace("standing:begin");
        try {
          await refreshUc();
          await uc?.rehelloIfChanged();
          if (!shuttingDown) await publish();
        } catch (error) { console.error("[user-computer-provider] standing re-hello check failed"); }
        lifecycleTrace("standing:end", { ucFollowUp, shuttingDown });
      } while (ucFollowUp && !shuttingDown);
    }).finally(() => {
      ucRefresh = undefined;
      if (!shuttingDown && ucCadenceStarted) ucRefreshTimer = setTimeout(requestUcRefresh, 2000); // Rre
    });
  };

  let ownershipTask: Promise<void> | undefined;
  let ownershipFollowUp = false;
  let ownershipTimer: NodeJS.Timeout | undefined;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    lifecycleTrace("shutdown:begin", { signal });
    clearTimeout(ucRefreshTimer);
    clearTimeout(ownershipTimer);
    logInfo(`received ${signal}, shutting down`);
    void (async () => {
      try {
        // Match official process-exit close: withdrawPresence:true (D:IDe L79748–79749).
        lifecycleTrace("shutdown:close-begin", { uc: !!uc, box: !!box });
        const ucClose = uc?.stop({ withdrawPresence: true });
        box?.beginShutdown();
        await shutdownShells();
        lifecycleTrace("shutdown:shells-done");
        await Promise.all([
          box?.stop(),
          ucClose,
        ]);
        lifecycleTrace("shutdown:close-done");
      } catch {
        /* ignore */
      }
      // Official lgt.close awaits standing tick `w` then discovery publish `T` (D:L179528–179529).
      lifecycleTrace("shutdown:tick-wait");
      await ucRefresh;
      lifecycleTrace("shutdown:tick-done");
      await publishTask;
      lifecycleTrace("shutdown:publish-done");
      await clearDiscovery();
      lifecycleTrace("shutdown:exit");
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
    lifecycleTrace("inflight", { transport, n, inflightCount });
    void publish();
  };

  const tryStartBox = async () => {
    if (box || shuttingDown) return;
    const conn = await loadConnection();
    if (!conn || shuttingDown) return;
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
    // Box path left as before this round (not part of the UC Ve/start evidence).
    await publish();
    void box.start().catch(() => undefined);
  };

  /**
   * One UC standing/credential pass — official Ve body (D:L179343–179424):
   * await ae(); SA mismatch → await close() without withdraw; if (y) return; construct; V.set; ye.start();
   * discovery publish happens after Ve (D:L179425–179427 / Rt L179479), never between set and start.
   */
  const refreshUc = async () => {
    if (shuttingDown) return;
    const payload = await loadSealedCredential(key);
    if (shuttingDown) return;
    const ch = payload && pickUserComputerChannel(payload);
    if (!ch) {
      const old = uc; uc = undefined;
      await old?.stop(); // D:L179346–179348: removed scope closes without withdrawing
      return;
    }
    if (uc) {
      // D:L179352: same mode keeps provider; rehello/runLoop resolve the current scope dynamically.
      if (uc.serverAuthoritative === (ch.serverAuthoritative === true)) return;
      const old = uc;
      uc = undefined;
      // SA flip: provider.close() with default withdrawPresence undefined/false (D:L179354).
      await old.stop();
    }
    // Official: after await ae() / optional close, always `if (y) return` before construct (D:L179356).
    if (shuttingDown) return;
    const provider = new UserComputerProvider({
      backendUrl: ch.backendUrl,
      machineId: ch.machineId || computerId,
      credential: ch.credential,
      accountScope: ch.accountScope,
      resolveChannel: async () => {
        // D:L179387–179395: resolve the provider's scope afresh, without changing its fixed SA mode.
        const latest = await loadSealedCredential(key);
        const channels = latest?.userComputers?.length ? latest.userComputers : latest?.userComputer ? [latest.userComputer] : [];
        const scope = ch.accountScope ?? `legacy:${ch.machineId}`;
        const live = channels.find(c => (c.accountScope ?? (channels.length === 1 ? `legacy:${c.machineId}` : undefined)) === scope);
        return live && latest ? { backendUrl: latest.backendUrl, machineId: live.machineId, credential: live.credential } : null;
      },
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
    // Official: (V.set(...), ye.start()) with no await between (D:L179423).
    uc = provider;
    servingAt = Date.now();
    void provider.start().catch(() => console.error("[user-computer-provider] provider lifecycle failed"));
  };

  // Ownership tick: supervisor/lease + discovery PID superseded (official FDe/Jae/hce).
  // Generation is published into discovery from env; daemon does not compare generations.
  const ownershipTick = async (): Promise<void> => {
    if (shuttingDown) return;
    lifecycleTrace("ownership:begin");
    const supervised = await isSupervised();
    const lease = await loadLease();
    const hb = await readJsonIfExists<{ at: number }>(path.join(dataRootFromEnv(), "local-exec-supervisor.json"));
    const staleFor = Date.now() - (hb?.at ?? startedAt) - 90_000;
    const disc = await loadDiscovery();
    if (disc && disc.pid !== process.pid && pidAlive(disc.pid)) {
      supersededSinceMs ??= Date.now();
    } else {
      supersededSinceMs = undefined; // D:L179502: clear A before C, not after awaiting it.
      if (disc?.pid !== process.pid) await publish();
    }
    const supersededForMs = supersededSinceMs == null ? null : Date.now() - supersededSinceMs;
    const decision = ownershipDecision({
        supervisedFresh: supervised,
        lease,
        inflightCount,
        supervisorStaleForMs: staleFor,
        supersededForMs,
      });
    lifecycleTrace("ownership:decision", { owner: disc?.pid, otherAlive: disc ? pidAlive(disc.pid) : false,
      inflightCount, supervised, staleFor, supersededForMs, decision });
    if (decision === "exit") {
      shutdown(supersededSinceMs != null ? "superseded" : "unsupervised");
    }
  };
  // D:78810 vre=10000; hc/yre starts leading and schedules from async completion (D:78474–78545).
  // Separate from standing Rre=2000. Pokes coalesce, never overlap a pending read/publication.
  const requestOwnershipTick = (): void => {
    if (shuttingDown) return;
    if (ownershipTask) { ownershipFollowUp = true; return; }
    clearTimeout(ownershipTimer);
    ownershipTimer = undefined;
    ownershipTask = Promise.resolve().then(async () => {
      do {
        ownershipFollowUp = false;
        await ownershipTick();
      } while (ownershipFollowUp && !shuttingDown);
    }).catch(error => {
      lifecycleTrace("ownership:error", { kind: error?.name });
      shutdown("ownership-state-error");
    }).finally(() => {
      ownershipTask = undefined;
      if (!shuttingDown) {
        ownershipTimer = setTimeout(requestOwnershipTick, 10_000);
        ownershipTimer.unref();
      }
    });
  };

  for (let i = 0; i < 50 && !box && !uc && !shuttingDown; i++) {
    await tryStartBox();
    requestUcRefresh();
    await ucRefresh;
    if (!box && !uc) await delay(100);
  }

  // Box retry keeps its existing cadence. UC standing has an independent completion-anchored 2s timer.
  setInterval(() => { void tryStartBox().catch(() => undefined); }, 1000);
  ucCadenceStarted = true;
  requestUcRefresh(); // D:179481 standing registration precedes ownership (179493).
  requestOwnershipTick(); // Both policies lead before the outer entrypoint announces started (187316–187335).
  await Promise.resolve(); // Registration's leading callbacks begin; readiness does not await their completion.
  lifecycleTrace("startup:ready");
  logInfo(`started (pid ${process.pid}); serving local exec over the gateway`);
}

main().catch(() => exitFatal());
