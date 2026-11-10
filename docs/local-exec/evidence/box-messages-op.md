# Box `messages-op` and Mwr replies

Evidence:
- D: is daemon.formatted.cjs.
- W: is `dist/local-exec-daemon/messages-worker.cjs`, statically extracted from the app.asar in the Linux 0.79.3 deb. Size is 121022 bytes; sha256 b6f5c672…667b matches the asar integrity hash. It was formatted to /tmp/exec-t155-evidence and **never executed**.

## Frame schema
- Box frame: rHt D:97430–97435 `{kind:"messages-op",requestId,op:rk,approvalId?}`. The frame is a non-strict object, so `sendKey`/`draftCard` are dropped.
- `rk` D:97154–97177 is a union of strict objects:
  - find-chats, items, search, activity
  - send (`to` or `chatId`)
  - check-permissions, fetch-attachment
  - find-contacts (query trimmed, min length 1)
  - Dates are iso-datetime with an offset. `limit` is an int ≥ 1. `before` is `{date,id:int}`.
- Port: `src/box/messages-op.ts` (zod/v4 `strictObject`, `iso.datetime({offset:true})`).

## Mwr (D:137547–137553)
If the frame fails JSON or schema parsing, the original logs `dropping unparseable request frame`. If the frame has `kind==="messages-op"` and a non-empty string `requestId`, it replies `{kind:"messages-error",requestId,error:z2}`. z2 is D:97405. Otherwise nothing is sent.

## handleMessagesOp, Box path (D:v_.handle 135972–135983, handleMessagesOp 136044–136127)
Box builds v_ without decideLocalUse and without draftCard.
1. `withInflight(requestId)` (D:136032): a duplicate in flight is ignored.
2. `withSendKey(undefined)` runs directly.
3. `replayedSend`: finishedSends holds an entry with the same requestId and the same `JSON.stringify(op)` → replay it.
4. Capability gate:
   - `l = iLe(messagesEnabled, {read,send})` (D:80533; settings D:82042–82044, defaults false/true/true).
   - `v6r` (D:135858) checks it. Failures: o5 (D:81184) or Qae(read|send) (dFt D:80544–80550).
   - This error is **not** remembered.
5. `isLocalUseBlocked({approvalId, authorization:{kind:"none"}, describes:nk(op)})`:
   - nk is D:97333; Vjt/jjt/Hjt is D:97317.
   - Qce D:81473–81502 / AUe D:81503:
     - `read-messages` = setting class → messagesEnabled ? allow : o5.
     - `send-imessage` = subject class → Box has no accountScope, so standing grants never apply. That leaves the approval record, else i5 (ASK).
   - A refusal is not remembered.
6. Cancelled before start (handleCancel D:136353 sets the flag) → Gl/Kce (D:81180). This one is remembered.
7. `messages.run` (Dpt D:135808): a worker; the error message is the worker's error code, wrapped by Wn (D:78677).
8. rememberSend applies only to `op.kind==="send"`. finishedSends is capped at U5e=64, oldest evicted first.

## Worker behaviour reachable on Linux
- nd (W:6480+) and Er (W:6061–6125) route every op to the sidecar helper.
- `ot()` (W:101, same lookup as D:Ed 83034) finds nothing.
- W:Hi 412 throws `sidecar_missing`, and Ws/Us keeps that code.
- **Result:** on Linux every op that passes the gate and authorization ends in `messages-error "sidecar_missing"`.
- `send` does its checks first:
  - ps/hs W:5965–5980: `send_text_empty`, `send_chat_id_invalid` (`/^[A-Za-z0-9._@;+-]+$/`), `send_recipient_invalid` (E.164 or email).
  - ys W:6000: writes `messages-mac-send-*/body.txt` with mode 0600, then deletes it in `finally`.

## Unreachable or not ported
- `messages-result` (bJe/qpe, R6r/I6r timings) needs a working macOS sidecar, so it is not produced.
- When a sidecar is found, the port returns a **non-original** placeholder, `helper_<verb>_failed`. The macOS helper RPC (service.json / launch / socket) was not ported.
- The worker's 30 s read expiry (T6r/vJe) cannot happen, because no read op ever reaches the helper.
- UC messages-op (consent flow decideLocalUse, sendKey/sentByKey, draftCard, `messages-consent-result`) is outside Box and not ported.
