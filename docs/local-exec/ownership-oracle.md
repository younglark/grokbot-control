# Ownership scheduling and preserved publication race (0.79.3)

This is narrow lifecycle evidence, **not full drop-in acceptance**. Historical intermittent 20-second failures remain unattributed. No CAS, cross-process lock, or new ownership policy is introduced. Approval quirks and the newline-cwd security fix remain unchanged.

## Static mechanism

Line references refer to the existing formatted 0.79.3 `daemon.formatted.cjs`, not an executable replacement for the raw artifact:

- 78810: `vre = 1e4`; 179430–179431: the default ownership policy uses `intervalMs: vre` (**10 seconds**). Standing uses `Rre = 2e3`, at 179434.
- 78474–78545: async callback settles before a completion-anchored next cadence; 78570–78586: a poke while ticking records one follow-up, default leading tick.
- 179427: initial Ve/publication is awaited. Standing registration/leading callback at 179481 precedes ownership registration/leading callback at 179493. Only after `await lgt(...)` does the outer entrypoint announce started (187316–187335). Started does **not** guarantee publisher quiescence.
- 179193–179239: C/v pending/running publication coalescing; busy caller returns, T tracks the work for close. 179502 clears A before republishing a dead/missing owner. 179528–179529 wait standing w then T on close, not an added global lock.
- 179202–179207 guard reads before publication; 80591–80602 provides an in-process path queue, not cross-process ownership CAS. The async writer reaches actual callback rename after write/fsync/close at 80644–80654. A new live owner may be overwritten in this interval.
- 79879–79886: Jae/FDe live-PID/superseded decision. 79743 gives the exact official log; 187306–187313 logs shutdown, awaits close, exits 0.

The independent index now starts both leading policies before ready, standing first; ownership is completion +10s, independent from standing completion +2s. Fake-clock/gated lifecycle tests assert both intervals, blocked reads, coalesced follow-up, startup order, and disposal. Missing discovery is republished only after clearing A, matching 179502. Existing ownership-error shutdown behavior and bootstrap/provider differences are not claimed fully identical to the original.

## Historical full-process and independent evidence

Compact factual records live in `scripts/oracles/ownership/historical-{independent,official}.json` (under the daemon package). They do not contain artifacts, credentials, machine paths, or large dumps.

- Independent implementation (t142, before 10s alignment): two fixed real-child scenes; overwritten owner causes the inner full 20000ms expectation to fail (~20001.54ms), with 10 keep decisions and 3 pongs; recovery exits 0. After-rename counterfactual exits in ~2011ms. Two additional extracted original C/v comparisons were **not** full official runs.
- Full official 0.79.3 (t145): two raw-daemon instances, one per fixed scene. The guard read sees self; a 14.555ms gate pauses actual rename; fixture replaces owner with a live PID; release lets native rename overwrite it with self. During the released 20s observation, 11 actual reads see self and 4 pongs show responsiveness. Inner exit expectation fails at 20004.903ms. Rewriting the live owner again gives normal exit 0 after ~7932ms.
- First official harness then exited **1** because it expected the independent implementation's shortened superseded text, even though recovery had already exited 0. This failure is retained, not erased. The separate, not-yet-run control used the exact official literal; first scene was not rerun.
- After-rename official control: gate only 6.126ms; live owner remains visible. At ~9981.5ms the original prints shutdown, original exit ~9987.1ms, parent observes exit ~10018.5ms; the 20s expectation passes at ~10024.8ms. This is consistent with **10s ownership**, not 2s standing. The 2s guard reads are not ownership-exit decisions.

These controlled interleavings prove that the complete original daemon shares the race. They do **not** identify the cause of the earlier intermittent failures, show unhooked occurrence frequency, or prove broader compatibility.

Official raw main SHA256: `5c1424ed3784704abbb20e83ced15ab8ebd161ddef5e7f1a74eed374453d36be`. Historical Node runtime: v24.22.1, SHA256 `e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb`. The readonly runtime-input copy had the same main hash. The raw program, not the formatted file, was executed.

## Reusable two-scene oracle (not part of default tests)

Official execution requires explicit opt-in, compatible Node, the approved external raw artifact and previously prepared runtime dependencies. Neither artifact nor runtime is vendored. Paths below are caller-supplied, not machine-specific defaults:

```sh
python3 packages/local-exec-daemon/scripts/oracles/ownership/launch.py \
  --official --artifact "$OFFICIAL_MAIN" --input-dir "$OFFICIAL_INPUTS" \
  --node "$NODE_RUNTIME" --out "$NEW_EVIDENCE_DIRECTORY"
```

For the independent built daemon, explicitly select `--implementation`, pass its compiled `index.js` and dist as artifact/input-dir, and `--node-modules "$PROJECT_NODE_MODULES"`. Do not use real credentials or service endpoints. The fake peer only emits welcome and empty responses, never jobs.

The launcher requires a new evidence directory and records exact argv/identity. Official main must match the pinned hash both before launch and inside the sandbox. It mounts only that raw artifact and dependencies, never a real HOME. `bwrap --unshare-all` supplies private network/PID/filesystem namespaces; the runner verifies no real HOME/workspace/proc-root escape, only lo and no external route **before** starting either daemon. No isolation fallback exists. Clear environment, synthetic HOME/XDG/data/root/key, all backend/origin/website endpoints explicitly loopback, telemetry disabled; an additional Socket connect guard rejects nonloopback, while native networking remains constrained by the namespace. Original bootstrap IPC disconnect is not overridden.

Preload wraps actual fs read and rename boundaries (official callback rename; implementation promises.rename), logs monotonic/time-origin/PID/read IDs immediately, and uses synthetic control files for gating and responsiveness probes. Gate is released and native completion confirmed **before** the full 20000ms expectation starts. A 2s emergency gate watchdog is asserted not to fire; each case has a 65s safety deadline and the entire batch 130s. Exact child PID TERM/KILL, fake-peer closure, namespace teardown and removal of only newly created synthetic state happen in cleanup. Evidence/failures remain. If a scene unexpectedly fails, the batch stops, without retries or additional scenes.

Outer scene assertions expect the overwritten-owner scene's **inner business exit failure**, then recovery; counterfactual expects a genuine clean superseded exit within the same unchanged 20s deadline. The shared exact-log helper is tested with synthetic strings, so fixing the old literal does not require another official run. New reusable scripts were not represented as new official runtime results.

To eliminate this window rather than preserve it would require an explicit compatibility-policy decision, not an unannounced CAS patch. Closing-flow/credential feature work is out of this batch.
