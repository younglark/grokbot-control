# Standing grants and non-exec approval classes (t155)

| Item | Evidence | Port (`src/uc/approvals.ts`) |
|---|---|---|
| Storage | `local-tool-standing-grants.v1.json` under the data root (LDe D:79826). The host app writes it; the daemon only reads it. mUe (D:81263) re-reads it on every decision, and any error → empty. | `readStandingGrants`, `standingGrantsPathFor` |
| Format | JLe: `{version:1,grants:[…]}`. rJt: `scope` is "action" or "subject". `action` must be a known action of class subject. `accountScope` is trimmed and non-empty. `grantedAtMs` is finite and ≥ 0. A subject grant carries a `recipient` (trimmed, 1–320 chars, no CR/LF) and an optional `recipientName`. | `parseStandingGrants` |
| Match key | $Le: `JSON.stringify([accountScope,scope,action(,recipient)])`. Duplicates keep the first entry. | `grantKey` |
| Expiry | **None.** `grantedAtMs` is never compared. | same |
| Eligibility | LLe D:81091: false if the ceiling is set and not "always", or if permission is "never". Otherwise allowed when messagesEnabled is true or the action is not read-messages/send-imessage. | `standingEligible` |
| Use | Cqt D:81454–81472: false if there is an approvalId, if accountScope is undefined, or if LLe fails. Otherwise a matching action grant or subject+recipient grant → allow. | `standingAllows` |
| Class flow | Qce D:81473–81502: the setting class (read-messages) gives messagesEnabled ? allow : o5. The subject class (send-imessage, use-app) checks standing first, then the approval record. | `decideExecLocalUse` |

Box: re() (D:179276–179288) passes `accountScope: undefined`, so standing grants never apply on Box (this matches the original). UC exec never describes a subject-class action, so on the paths implemented today a grant only takes effect through the API.

Not ported:
- the spent-sends store xUe (`local-tool-spent-sends.json`, used by send-mail and device tools);
- the consent flow and the device/local-tool paths.

The daemon does not create grant records.
