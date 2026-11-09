# UC messages-op (t156)

Evidence comes from two sources, read statically only:
- D: = daemon.formatted.cjs.
- W: = the messages-worker statically extracted in t155. It was never executed.

## Frame intake: v9r `messagesOp`, D:178909–178926
- `op` = AJe(opJson) (D:97356): `rk.safeParse(tn(json))`. JSON or schema failure → undefined → w9r (D:178785–178793) replies `messages-error` with z2. When requestId is empty, nothing is sent.
- `sendKey` = T9r (D:178859): only a non-empty string counts.
- `draftCard` is set only when the frame has `draftCard === true`.
- `authorization: {kind:"approval"}` is set only when `draftCard && authorizedByApproval`.
- Port: `parseQueued` (`src/uc/provider.ts`), sharing `messagesOpSchema`.

## Executor: one v_ per UC provider (D:Ve 179353–179365)
Wiring:
- `decideLocalUse` = Qce(re(Y, accountScope, SA)).
- `isLocalUseBlocked` = AUe(re(...)).
- `messagesCapabilities` = iLe(settings).

Shared logic: `MessagesExecutor` in `src/box/messages-op.ts`. Box and UC each own one instance.

| Step | Original | Notes |
|---|---|---|
| Dedupe | withInflight → withSendKey (D:136294) → replayedSend (D:136272) | Sends sharing a sendKey run serially. Replay looks up finishedSends by requestId, then sentByKey by sendKey. The op JSON must match, and the frame is re-labelled with the current requestId (Bpt). |
| `u` | `op.kind==="send" && !M6r(approvalId)` | Only a send without an approvalId takes the consent path. |
| Capability gate | v6r | u+consent → `messages-accepted` + `messages-consent-result{refused,reason}` (remembered). Otherwise `messages-error` (draftCard → Lpt code), not remembered. |
| Consent | `messages-accepted`, then Qce({approvalId:undefined, authorization none, describes:nk}) | A non-allow verdict → `messages-consent-result` (ask/refused, remembered). On allow, AUe is **not** run again. |
| Non-consent | AUe({approvalId, authorization: draftCard&&auth ? auth : none}) | A refusal → `messages-error` (draftCard → Lpt), not remembered. |
| Cancelled | `r.cancelled` | `messages-error` Gl, or `messages_send_cancelled` for draftCard (remembered). |
| Run | messages.run(op, maxFileBytes, timings, {draftCard}) | On Linux this always fails with `sidecar_missing` (W:Hi 412). The draft-card helper client also logs `[messages-worker] helper <verb> failed: …` (W:js 6291 + rd 6480). |
| rememberSend | D:136279 | Only for send. Stores in finishedSends (64, FIFO). D6r (D:136436) also stores into sentByKey, but only for messages-result, or for a draftCard messages-error that is in neither Wue (JI, D:84657) nor qI (D:84686). |

## Reply frames: Y_, D:179001–179040
| Frame | Encoding |
|---|---|
| `messages-error` | `messagesError{error}` |
| `messages-accepted` | `messagesAccepted{}` |
| `messages-consent-result` | `messagesConsentResult{verdict: I9r(allow→STANDING, ask→ASK, refused→REFUSED), reason?}` |
| `messages-result` | `messagesResult{resultJson, daemonMs/helperMs/sqliteMs}`. If resultJson is longer than K_ (8 MiB), it becomes `messages-error Od`. |

Lane budgets x9r (D:178820–178826): messagesResult / Error / ConsentResult = Gpe 180 s; messagesAccepted = none. B8r sizes are in `reply-lanes.ts`. Keepalives were already `messagesAccepted`.

## Closing replies: zl, D:136449–136464
For a draftCard messages-op, A9, F5e and Gl map to codes through Fpt (D:135897): `messages_local_exec_closing`, `messages_local_exec_busy`, `messages_send_cancelled`. Port: `closingFrame`.

## Cancellation
handleCancel (D:136353) sets `cancelled` on the in-flight entry. The port uses the provider's `cancelledIds`, the same signal used by the cancel ACK path.

## spent-sends xUe
In D:179371–179381, `spendSendApproval` serves only `mac_send_mail` (local-tool / Mpt x6r). It is **not on the messages-op path**. See local-tools-evidence.md.

## Unreachable on Linux, not ported
- The `messages-result` payload (TJe/qpe/R6r turnedOff, I6r timings) needs a working helper.
- The worker's 30 s read expiry (T6r) is unreachable for the same reason.
- When a sidecar is found, the port returns the placeholder `helper_<verb>_failed`, which is not original behavior. W:Ws uses the same fallback name for unknown failures.
