# local-tool and device tools: evidence and plan (t156, not implemented)

## Dispatch: handleLocalTool, D:136131–136240
The order is:
1. `Opt(toolId)` (`mac_send_mail` / `mac_mail_accounts`, D:79443/79499) → Mpt (D:135625):
   - **accounts (h6r):** if `deviceTools.mail()` is undefined → `failed "mail_accounts_unavailable"` (hke).
   - **send (x6r):** needs an approvalId plus `spendSendApproval`, i.e. xUe (`local-tool-spent-sends.json`, D:179371). Each outcome is mapped (already-spent / blocked / missing / mismatch / spent), then sent through macMailTransport.
2. `deviceTools.offers(toolId)` (Ppt, D:135510):
   - Location (vft) is offered only on darwin with a sidecar, so never on Linux.
   - ppt: reminders, calendar and similar macOS tools.
   - **Obsidian (Ipt, D:135418):** only after `readGate()` and `ypt(dataRoot)` find a vault. This is the only device tool that may be reachable on Linux.
   - Flow: accepted → deviceToolConsent (isDeviceToolBlocked = TUe, consentApp, decideAppUse) → cancelled? → run (permission pending/granted hooks) → result.
3. `!gJe(toolId)` (E5, the 14 `computer_*` tools, D:84699) → `local-tool-result failed B5e` (`This computer has no "<id>" tool.`).
4. Computer-use tool → `local-tool-accepted` → UL.call (D:136514):
   - ewr checks the arguments.
   - Calls run one at a time per conversation; while one waits, it sends an `onStillQueued` keepalive.
   - callNow → availableHelper. Xpt (D:136712) returns undefined on non-darwin, unless the sand-dev variant has `local-cua-helper.json`.
   - **On Linux this always ends in `failed BL`** ("Computer use is not available on this computer right now.").

## Hello (UC, D:178140–178175)
- `mobileLocalTools` / `localStandingGrants` / `localToolAppConsent` / `localToolHelperName` come from `localTools()`.
- On Linux, computerUse is `[]`; device is empty unless an Obsidian vault is ready.

## Frames
- `local-tool-accepted{permissionGranted?}`, `local-tool-permission-pending{reason?}`, `local-tool-result` (R9r: done / failed / needs_permission / ask→outputJson app).
- Lane budget a9r is 180 s. Box Dwr does not relay any local-tool frame.

## Port today and plan
- **Port today:** UC localTool frames fall into the "not understood" closing reply (`control throw z2`). That **differs** from the original, which always maps v9r localTool.
- **Plan, reachable parts in order:**
  - (a) v9r localTool intake.
  - (b) unknown tool → B5e.
  - (c) computer_* → accepted + BL, including the per-conversation queue and the onStillQueued keepalive.
  - (d) mail tools → hke for accounts. For send, the x6r path with xUe spent-sends.
  - (e) Obsidian vault tools (Ipt/ypt/bpt/Apt) need a separate reverse-engineering pass.
- Local-tool replies also need the hello capability fields (mobileLocalTools).

## t158 implementation (`src/uc/local-tools.ts`, `src/uc/provider.ts`)
Implemented:
- **Intake:** parseQueued handles `case "localTool"`.
- **Mail (Opt → Mpt D:135625):** on Linux mail is undefined.
  - mac_mail_accounts → h6r returns `failed mail_accounts_unavailable` (hke) directly, with no accept.
  - mac_send_mail → x6r (D:135728) returns `failed mail_send_unavailable` (cse) before spendSendApproval. **So xUe (local-tool-spent-sends) is unreachable on Linux and is not ported.** This corrects the earlier line above saying send goes through xUe; that only applies on darwin with mail available.
- **Unknown tools:** a non-E5 tool → B5e result only (D:135477).
- **computer_*:**
  1. Sends accepted (permissionGranted unset), then runs UL.call (D:136514).
  2. ewr (D:136738) validates the call: not-E5 / empty conversation / non-object args / `null`→{}.
  3. Calls run one at a time per conversation. While a call is queued, the q6r 60 s keepalive (leading=false) sends another accepted frame (onStillQueued).
  4. Cancel/abort → Gl.
  5. availableHelper is always undefined → BL.
- **Frame encoding (Y_/R9r D:179042–179078, D:178942):** done/failed/needs_permission/ask. Done results over 8 MiB → PJe.
- **Closing:** zl closing → local-tool-result failed.
- **UC hello capabilities (D:178137–178175, Linux):** `{messagesOp/localStandingGrants only if a sidecar is present, messagesOpGeneration:4, aiToolSetup:true, mobileLocalTools:[]}`. computerUse and device are empty, so localToolAppConsent, localToolGrantSeen and localToolHelperName are omitted.

Documented only, not ported:
- **Obsidian:** implemented in t159; see obsidian-evidence.md.
- **The computer-use dev override:** on non-darwin, the helper is still found if the sand-dev `local-cua-helper.json` override exists and the NLe gate is open (Xpt D:136712). This is not ported; the port always returns BL.
- **The darwin helper / sidecar path:** not ported.
