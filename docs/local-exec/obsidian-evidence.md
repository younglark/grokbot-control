# Obsidian vault device tools (Ipt) — t159

**Reachable on Linux.** Ppt (D:135510) always builds Ipt with `rootDir: () => Zn()`; readGate is QR. Location (vft) and the mac tools (ppt) are inert on Linux, but Ipt is not.

## Gate and discovery
- **QR (D:81023).** Reads `<Zn()>/mac-device-tools-gate.json` (bTe) via _d with failOpen and the schema `{isOn: boolean}`; only `isOn === true` opens the gate. Any read, parse or shape failure means off.
- **ypt (D:135075).** Reads `<Zn()>/obsidian-vault.json`, a strict `{path: min 1}`, and requires `stat(path).isDirectory()`.
  - A missing file (ENOENT/ENOTDIR) is silent.
  - Other failures log `obsidian vault config read failed: <xt>` or `...: invalid schema`.
- **refresh (D:135443).** Runs on every localTools() call: before each Watch (D:178368), and on every 2 s standing check through rehelloIfChanged (D:178214). The Watch is raced with C6r = 2500 ms.

## Hello and dispatch
- **Hello.** mobileLocalTools gains `{toolId: mac_read_obsidian | mac_write_obsidian, state: "ready", features: []}` (D:178160–178169).
  - consentApp is undefined (Ppt: e.offers ? oke : ppt.consentApp; Ch(Sb) is not in ake), so u stays false. No localToolAppConsent, localToolGrantSeen or localStandingGrants is added.
  - A changed localTools JSON → rehello.
- **handleLocalTool device branch (D:136170–136204).**
  1. accepted.
  2. deviceToolConsent: isDeviceToolBlocked = TUe (D:81514), so permission or ceiling "never" → Xh.
  3. consentApp undefined → no ask.
  4. Cancelled → Gl.
  5. Otherwise run.
- **run (D:135455).**
  - Not offered → QEr.
  - Unparseable JSON → ZEr.
  - Schema failure (e6r/t6r) → Tpt.
  - Vr refusal → its message.
  - Any other error → XEr.

## Operations
- **bpt read (D:135266).**
  - Lists notes with wpt: dot entries and symlinks skipped; `.md` files only; the realpath must stay in the vault.
  - Folder filter; sort by mtime descending, then id with localeCompare.
  - Query match: title, or the first 200000 chars, lowercased with toLocaleLowerCase("en") and ς→σ.
  - 240-char snippet; limit defaults to 20 (max 50); truncated when more notes match.
  - id read: xpt, then the first 20000 chars with bodyTruncated.
- **Apt write (D:135321).**
  - create: WEr title → KEr makes the missing folders inside the vault → lstat (symlink → ql, existing → k5e) → writeFile with flag wx.
  - append: currentTitle must match (jEr) → xpt → add "\n" when the last byte is not a newline → appendFile.

## Port
- Port: `src/uc/obsidian.ts`, plus `createDeviceTools` / `localToolsSnapshot` / `helloLocalToolCapabilities` in `src/uc/local-tools.ts`, plus the UC provider hello and rehello.
- Tests: `test/t159-exchange-obsidian-cp.test.cjs`, using a temp data root, a synthetic gate file and a temp vault. Nothing touches the real home config.
- **Zn difference:** rootDir uses the port's dataRootFromEnv (SAND_DATA_ROOT / SAND_USER_DATA_DIR / ~/.sand-local-exec). This is the same root used everywhere else in the port, not a byte-exact Zn port.
