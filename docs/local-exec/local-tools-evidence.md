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
