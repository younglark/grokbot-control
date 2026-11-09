#!/usr/bin/env node
import { lifecycleTrace } from "./trace";
import { shutdownShells } from "./exec/handlers";
import { readJsonIfExists, dataRootFromEnv } from "./util";
import * as os from "node:os";
import * as path from "node:path";
import { awaitHandoff, exitFatal } from "./bootstrap/handoff";
import { loadSettings } from "./settings";
import { clearDiscovery, isSupervised, loadDiscovery, publishDiscovery } from "./state/discovery";
import { loadConnection, writeConnection } from "./state/connection";
import { BOX_IDLE_FOR_UC, BOX_NO_CONNECTION, SandLocalExecConnectionError, backendClientFromEnv, exchangeConnection, variantForNamespace } from "./state/connection-exchange";
import { createDeviceTools } from "./uc/local-tools";
import { createStandingSignals } from "./state/standing-signals";
import { BoxProvider, describeError } from "./box/provider";
import { UserComputerProvider } from "./uc/provider";
import { aiToolConfigDirsFromEnv } from "./uc/ai-tool-discovery";
import { loadSealedCredential } from "./uc/credential";
import {
  generationFromEnv,
  loadLease,
  ownershipDecision,
  pidAlive,
} from "./state/lease";
import { localRootFromEnv, logInfo, delay } from "./util";
import { applyNodeProxyEnv } from "./state/node-proxy";
import { scrubBootEnv } from "./bootstrap/boot-env";

// D:sqr 187195–187207 → `var Ly = sqr(process.env)` at module load, before the handoff: SAND_NODE_PROXY_ENV is
// removed from the env and applied process-wide (nke 79217); its fingerprint goes into discovery.
// Same pass also drops SAND_LOCAL_EXEC_INHERITED_FDS (closing those fds, wDe D:79653), SAND_LOCAL_EXEC_FILE_KEY and
// NODE_USE_SYSTEM_CA, in sqr's order (D:187196–187200).
const bootEnv = scrubBootEnv(process.env);
const nodeProxy = applyNodeProxyEnv(process.env);

class StandingAbort extends Error {}

async function main(): Promise<void> {
  // D:187322–187325: CLAUDE_CONFIG_DIR / CODEX_HOME captured once at daemon start.
  const aiToolConfigDirs = aiToolConfigDirsFromEnv();
  // D:aqr = iqr() (187285) then cqr 187302–187303: a handoff without a computerId (timeout, disconnect, no channel)
  // is fatal (YAe → `fatal: Error`); a bad key alone is not: the daemon serves with fileKeyBase64 null (plaintext files).
  const handoff = await awaitHandoff(5000, bootEnv.preIpcFileKeyBase64);
  if (handoff.computerId === undefined) exitFatal();
  // D:cqr 187314: eke(process.env, "desktop") runs right after the handoff; QPe may throw IsolatedDeploymentConfigError,
  // which the outer catch reports as `fatal: ${xt(e)}` and exit 1 (D:187341–187348).
  const client = backendClientFromEnv();
  // D:lgt p = l() (179176): startedAt is taken when the daemon body starts, after the handoff; servingAt m = p.
  const startedAt = Date.now();

  const { key } = handoff; const computerId: string = handoff.computerId;
  const root = localRootFromEnv(); // raw, as wft → lgt root (D:187320)
  const { permission } = await loadSettings();
  const generation = generationFromEnv();

  let servingAt: number | undefined = startedAt;
  // D:x 179192: account scopes whose Watch was refused as unauthorized (onLoopEvent 179404–179412).
  const rejectedScopes = new Set<string>();
  let inflightCount = 0;
  let box: BoxProvider | undefined;
  // D:V 179246: one UC provider per account scope, with the serverAuthoritative value it was built for.
  const ucProviders = new Map<string, { serverAuthoritative: boolean | undefined; provider: UserComputerProvider }>();
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
            ...(nodeProxy === undefined ? {} : { proxyFingerprint: nodeProxy.fingerprint }),
            ...(rejectedScopes.size === 0 ? {} : { rejectedAccountScopes: [...rejectedScopes].sort() }), // D:179215
          },
          key ?? undefined,
        ).catch(error => {
          written = false; lifecycleTrace("publish:error", { kind: error?.name });
          console.error(`[local-exec-daemon] discovery publish failed (previous record stands): ${describeError(error)}`); // D:179220–179222
        });
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
  const standingSignals = createStandingSignals({ startedAt, log: m => console.error(`[local-exec-daemon] ${m}`) });
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
          // D:Rt 179463: (await He(), await ot(), ut()) before Ve — backend-return marker, then network fingerprint.
          await standingSignals.backendReturn(() => { for (const Z of ucProviders.values()) Z.provider.noteBackendReturn(); });
          standingSignals.networkChange(() => { for (const Z of ucProviders.values()) Z.provider.noteNetworkChange(); });
          let dropped: boolean;
          try { dropped = await refreshUc(); }
          catch (Y) { console.error(`[local-exec-daemon] standing re-hello check failed: ${describeError(Y)}`); dropped = false; throw new StandingAbort(); }
          if (dropped) await publish(); // D:179425 Z && d && await C()
          // D:179467–179476: every provider's rehelloIfChanged in parallel; failures are logged, not fatal.
          for (const r of await Promise.allSettled([...ucProviders.values()].map(Z => Z.provider.rehelloIfChanged())))
            if (r.status === "rejected") console.error(`[local-exec-daemon] standing re-hello check failed: ${describeError(r.reason)}`);
          // D:Rt 179478: y || (m = l(), d && await C()) — every completed standing tick moves servingAt.
          if (!shuttingDown) { servingAt = Date.now(); await publish(); }
        } catch (error) { if (!(error instanceof StandingAbort)) console.error(`[local-exec-daemon] standing re-hello check failed: ${describeError(error)}`); }
        lifecycleTrace("standing:end", { ucFollowUp, shuttingDown });
      } while (ucFollowUp && !shuttingDown);
    }).finally(() => {
      ucRefresh = undefined;
      if (!shuttingDown && ucCadenceStarted) ucRefreshTimer = setTimeout(requestUcRefresh, 2000); // Rre
    });
  };

  let ownershipTask: Promise<void> | undefined;
  let ownershipStopped = false;
  let lastOwnershipTickAt: number | undefined; // D:J 179495
  let staleHeartbeatToleratedUntilMs: number | undefined; // D:K 179495
  let ownershipFollowUp = false;
  let ownershipTimer: NodeJS.Timeout | undefined;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    lifecycleTrace("shutdown:begin", { signal });
    clearTimeout(ucRefreshTimer);
    clearTimeout(ownershipTimer);
    // D:l$t 79742–79747 / IDe: reason text, then lgt.close under I7t (2 s, D:187191) and exit 0 either way.
    const reasonText: Record<string, string> = { superseded: "superseded by the daemon the discovery record names", unsupervised: "desktop ownership lost", SIGTERM: "received SIGTERM", SIGINT: "received SIGINT" };
    logInfo(`${reasonText[signal] ?? `received ${signal}`}, shutting down`);
    setTimeout(() => { lifecycleTrace("shutdown:deadline"); process.exit(0); }, 2000);
    void (async () => {
      try {
        // Match official process-exit close: withdrawPresence:true (D:IDe L79748–79749).
        lifecycleTrace("shutdown:close-begin", { uc: ucProviders.size > 0, box: !!box });
        const ucClose = Promise.all([...ucProviders.values()].map(Z => Z.provider.stop({ withdrawPresence: true })));
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

  // D:ne/he 179296–179300: one counter per transport ("box", `server:${scope}`), summed.
  const inflightByTransport = new Map<string, number>();
  const onInflight = (transport: string, n: number) => {
    inflightByTransport.set(transport, n);
    inflightCount = [...inflightByTransport.values()].reduce((a, b) => a + b, 0);
    lifecycleTrace("inflight", { transport, n, inflightCount });
    void publish();
  };

  // D:lgt 179165–179330: backend client identity (eke(env, "desktop").backend); Box/UC hello variant = HPe(boxNamespace).
  const providerVariant = variantForNamespace(client.boxNamespace);
  // D:q 179247: one device-tool set shared by every UC provider.
  const deviceTools = createDeviceTools({ rootDir: () => dataRootFromEnv(), log: m => console.error(`[local-exec-daemon] ${m}`) });
  /** D:Q 179250–179259: credential channels keyed by accountScope ?? (single → legacy:machineId). */
  const channelsByScope = (payload: Awaited<ReturnType<typeof loadSealedCredential>>) => {
    type Entry = NonNullable<NonNullable<typeof payload>["userComputer"]> & { backendUrl: string };
    const out = new Map<string, Entry>();
    if (payload == null) return out;
    let list = payload.userComputers ?? [];
    if (list.length === 0 && payload.userComputer !== undefined) list = [payload.userComputer];
    for (const u of list) {
      const scope = u.accountScope ?? (list.length === 1 ? `legacy:${u.machineId}` : undefined);
      if (scope !== undefined) out.set(scope, { ...u, accountScope: scope, backendUrl: payload.backendUrl });
    }
    return out;
  };
  /** D:X 179262–179266: a UC channel is live (SA, or not refused) → the Box dial stays idle. */
  const ucServes = async (): Promise<boolean> => {
    for (const [scope, u] of channelsByScope(await loadSealedCredential(key))) if (u.serverAuthoritative === true || !rejectedScopes.has(scope)) return true;
    return false;
  };
  /** D:we 179311–179315 */
  const readConnection = async () => {
    const c = await loadConnection(process.env, key);
    if (c == null) throw new SandLocalExecConnectionError(BOX_NO_CONNECTION);
    return c;
  };
  /** D:ge 179267–179277: exchange the sealed Box credential for a connection unless a UC channel serves. */
  const onConnectionStale = async (): Promise<void> => {
    const y = await loadSealedCredential(key);
    if (y?.credential === undefined || (await ucServes())) return;
    const z = await exchangeConnection({ client, backendUrl: y.backendUrl, credential: y.credential });
    if (z.kind === "unavailable") { console.error(`[local-exec-daemon] connection exchange unavailable (${z.reason}): ${z.detail}`); return; }
    await writeConnection(z.connection, key);
  };

  /** D:Te 179316–179331 + Te.start(): the Box provider always runs; the dial resolves the connection each time. */
  const tryStartBox = async () => {
    if (box || shuttingDown) return;
    box = new BoxProvider({
      root,
      computerId,
      // D:v_ constructor 135918–135920: computerLabel unset for Box → hostname().trim() || "this computer".
      label: os.hostname().trim() || "this computer",
      variant: providerVariant,
      permission,
      onInflight: n => onInflight("box", n),
      aiToolConfigDirs,
      resolveConnection: async () => {
        if (await ucServes()) throw new SandLocalExecConnectionError(BOX_IDLE_FOR_UC);
        return await readConnection();
      },
      resolveResponseConnection: readConnection,
      onConnectionStale,
    });
    // D:Te.start() 179332: constructing/starting the Box neither publishes discovery nor moves servingAt.
    void box.start().catch(() => undefined);
  };

  /**
   * One UC standing/credential pass — official Ve (D:179343–179424). One provider per account scope (V, D:179246):
   * scopes gone from the credential close (without withdrawing) and leave the rejected set; a scope whose
   * `serverAuthoritative` value changed (raw `===`, D:179352) closes and is rebuilt; `if (y) return` before every
   * construct (D:179356); new scopes get a provider, `V.set` then `start()` with no await between (D:179423).
   * Returns whether a rejected scope was dropped (`Z && d && await C()`, D:179425).
   */
  const refreshUc = async (): Promise<boolean> => {
    if (shuttingDown) return false;
    const Y = channelsByScope(await loadSealedCredential(key));
    let Z = false;
    for (const [scope, W] of [...ucProviders]) {
      if (Y.has(scope)) continue;
      ucProviders.delete(scope);
      Z = rejectedScopes.delete(scope) || Z;
      await W.provider.stop(); // D:179346–179348
    }
    for (const [scope, U] of Y) {
      const W = ucProviders.get(scope);
      if (W !== undefined) {
        if (W.serverAuthoritative === U.serverAuthoritative) continue;
        ucProviders.delete(scope);
        await W.provider.stop(); // SA flip: close() with withdrawPresence unset (D:179354)
      }
      if (shuttingDown) return Z;
      const provider = new UserComputerProvider({
        backendUrl: U.backendUrl,
        machineId: U.machineId || computerId,
        credential: U.credential,
        accountScope: scope,
        resolveChannel: async () => {
          // D:179387–179395: resolve this scope afresh; null when it is gone.
          const pe = channelsByScope(await loadSealedCredential(key)).get(scope);
          return pe === undefined ? null : { backendUrl: pe.backendUrl, credential: pe.credential, machineId: pe.machineId };
        },
        root,
        permission,
        aiToolConfigDirs,
        hello: {
          // D:v_ 135916–135918: computerLabel unset → hostname().trim() || "this computer".
          label: os.hostname().trim() || "this computer",
          localRoot: root,
          terminalsFolder: path.join(root, "terminals"),
          standing: permission === "always" ? "always" : permission === "never" ? "never" : "ask",
          variant: providerVariant,
          serverAuthoritative: U.serverAuthoritative === true,
          // capabilities are built by the provider on every Watch (D:hello 178137–178175).
        },
        onInflight: n => onInflight(`server:${scope}`, n), // D:he 179296–179300
        deviceTools,
        client,
        // D:onLoopEvent 179404–179420
        onLoopEvent: ev => {
          let changed = false;
          if (ev.kind === "connected") { changed = rejectedScopes.delete(scope); box?.redial(); }
          else if (ev.kind === "disconnected" && ev.reason === "unauthorized") { changed = !rejectedScopes.has(scope); rejectedScopes.add(scope); box?.wakeFromReconnectBackoff(); }
          else if (ev.kind === "channel-missing") box?.wakeFromReconnectBackoff();
          else if (ev.kind === "renewed") console.error(`[local-exec-daemon] user-computer watch renewed on a new connection after ${ev.cause === "silent" ? "15 s of silence" : "a network change"}`);
          else if (ev.kind === "presence-withdraw-failed") console.error(`[local-exec-daemon] user-computer presence withdraw failed: ${describeError(ev.error)}`);
          if (changed) void publish();
        },
      });
      ucProviders.set(scope, { serverAuthoritative: U.serverAuthoritative, provider });
      void provider.start().catch(() => console.error("[user-computer-provider] provider lifecycle failed"));
    }
    return Z;
  };

  // Ownership tick: supervisor/lease + discovery PID superseded (official FDe/Jae/hce).
  // Generation is published into discovery from env; daemon does not compare generations.
  const ownershipTick = async (): Promise<void> => {
    if (shuttingDown) return;
    lifecycleTrace("ownership:begin");
    const supervised = await isSupervised();
    const lease = await loadLease();
    // D:pce 81000 + $Ft 80881: a missing/invalid heartbeat ({pid:int>0, at:number}) reads as VFt {pid:0, at:0}.
    const raw = await readJsonIfExists<{ pid?: unknown; at?: unknown }>(path.join(dataRootFromEnv(), "local-exec-supervisor.json"));
    const hbAt = raw != null && Number.isInteger(raw.pid) && (raw.pid as number) > 0 && typeof raw.at === "number" ? raw.at : 0;
    const ue = Date.now();
    // D:179497: a tick gap longer than ITe (3 × vre = 30 s, e.g. a system sleep) tolerates a stale heartbeat for
    // Gy (90 s) from now (FDe staleHeartbeatToleratedUntilMs, D:79889–79892).
    if (lastOwnershipTickAt !== undefined && ue - lastOwnershipTickAt > 30_000) staleHeartbeatToleratedUntilMs = ue + 90_000;
    lastOwnershipTickAt = ue;
    const staleFor = ue - hbAt - 90_000;
    const disc = await loadDiscovery();
    if (disc && disc.pid !== process.pid && pidAlive(disc.pid)) {
      supersededSinceMs ??= Date.now();
    } else {
      supersededSinceMs = undefined; // D:L179502: clear A before C, not after awaiting it.
      if (disc?.pid !== process.pid) await publish();
    }
    const supersededForMs = supersededSinceMs == null ? null : Date.now() - supersededSinceMs;
    const decision = ownershipDecision({
        supervisedFresh: supervised || (staleHeartbeatToleratedUntilMs !== undefined && Date.now() < staleHeartbeatToleratedUntilMs),
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
      // D:yre 78466–78470/78528–78532: a failed tick with no retry policy stops the ownership cadence (reported as
      // "tick-failed" telemetry); the daemon keeps serving.
      lifecycleTrace("ownership:error", { kind: error?.name });
      ownershipStopped = true;
    }).finally(() => {
      ownershipTask = undefined;
      if (!shuttingDown && !ownershipStopped) {
        ownershipTimer = setTimeout(requestOwnershipTick, 10_000);
        ownershipTimer.unref();
      }
    });
  };

  for (let i = 0; i < 50 && !box && ucProviders.size === 0 && !shuttingDown; i++) {
    await tryStartBox();
    requestUcRefresh();
    await ucRefresh;
    if (!box && ucProviders.size === 0) await delay(100);
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

main().catch(error => exitFatal(error));
