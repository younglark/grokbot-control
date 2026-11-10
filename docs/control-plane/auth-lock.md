# Native auth locks

## Selection and evidence

`fs-native-extensions@1.5.3` (exact runtime dependency, Apache-2.0), upstream
[holepunchto/fs-native-extensions](https://github.com/holepunchto/fs-native-extensions/tree/8abcff878845fc0137360d76b1a821728ed8e0bf).
Inspected npm tarball sources, loader, package license and packaged prebuilds; not merely npm platform claims.

| Platform | Source | Nonblocking exclusive primitive | Packaged Node prebuilds |
|---|---|---|---|
| Linux | `src/linux.c:21–29` | `fcntl(F_OFD_SETLK)` / `F_WRLCK` | x64, arm64 |
| macOS | `src/apple.c:18` | `flock(LOCK_EX\|LOCK_NB)` | x64, arm64 |
| Windows | `src/win32.c:14–36` | `LockFileEx(LOCKFILE_EXCLUSIVE_LOCK\|LOCKFILE_FAIL_IMMEDIATELY)` | x64, arm64 |

`binding.c` converts Node fd with `uv_get_osfhandle`; N-API version 9 (`CMakeLists.txt:91–108`),
Node 20+ required. `index.js` returns false on EAGAIN; adapter also handles EBUSY contention.
`binding.js` uses `require-addon`; the npm tarball contains prebuilds (no postinstall script or runtime downloader).
Source build uses CMake >=3.25, C compiler/MSVC and upstream cmake-bare/cmake-fetch/cmake-napi/cmake-npm,
libuv 1.51.0 and bare-compat-napi. No Rust toolchain is required.

Compared with GrokBuild `xai-org/grok-build@2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`,
`crates/codegen/xai-grok-login/src/manager/lock.rs` and Cargo `fs2=0.4`:
permanent independent lock, OS-exclusive ownership across exchange, reread/adopt sibling rotation,
in-process singleflight. Linux OFD record locks have the same needed ownership/crash-release semantics,
**but are not the same lock namespace as flock**. This is not an fs2 binding and does not interoperate
with old util-linux-flock clients. Stop **all old MCP/CLI processes before upgrading**; do not mix versions
against one credential directory. No attempt to coordinate with GrokBuild's separate credentials.

## Runtime contract

`src/auth/lock.ts` isolates `AdvisoryLockBinding` from auth/provider/store. Default loads native binding
lazily. Missing/unsupported binding fails closed (`auth_lock_unavailable`) with installation guidance;
no mkdir, mtime lease, external executable, daemon, helper process, or silent fallback.

Permanent lock files are opened O_CREAT|O_RDWR, never truncated/replaced/unlinked. Unix uses O_NOFOLLOW,
regular-file/nlink checks and inode recheck after acquisition. File descriptors belong directly to the
requesting Node process; no child/helper can outlive the owner holding its lock. Node's file opening uses
non-inheritable/CLOEXEC handles; no fd is exported to child stdio. Unlock/close in finally; process crash
releases OS locks. A backdated mtime never authorizes takeover. Do not manually delete lock files.

Lock order: exchange `singleflight|kind|backend` → mutation `kind|backend`. Refresh holds exchange across
snapshot, HTTP and conditional save; mutation is held only for short reread/CAS/revoke operations.
Login/logout acquire only mutation, so they do not wait on network or reverse the order. Force captures
entry revision/session: a sibling's usable rotation satisfies that force. Changed account/session fails
rather than returning credentials for a different login. All cooperating writers must use this protocol.

Try-lock + async 25ms wait keeps Node's event loop responsive. Wait budget defaults to 30s; AbortSignal
cancels only waiting, not an acquired exchange. The caller-visible HTTP budget is <=20s, but the IdP
exchange is never aborted mid-flight (Grok Build BoundedRefresh semantics): on deadline the caller gets
`outcome=unknown` / `rpc_dispatched=unknown` while the exchange continues under singleflight and still
persists a successful rotation. A follow-up `invalid_grant` inside that ambiguous window does not wipe
credentials. Transient cooldown is per `session_id` (memory + disk); a re-login must not inherit the
previous session's cooldown. Wait/deadline failures are structured and do not retry forever.

## Install/build/distribution

Normal users: `npm ci` (or `npm ci --ignore-scripts`) installs exact package + integrity-pinned tarball
from package-lock.json, including publisher-supplied prebuilds; no compiler/Rust normally needed.
No binary is committed here. The dependency is required (not optional); missing platform binary is a
runtime fail-closed error, not a lease downgrade. Non-listed targets (including unverified musl variants)
are unsupported until a source build and tests pass.

Source-build recipe (maintainer/CI, **not automatic install fallback**): in the installed
`node_modules/fs-native-extensions`, install upstream devDependencies (`npm install --include=dev
--ignore-scripts`), install upstream bare-make toolchain, remove shipped prebuilds, then run
`bare-make generate --platform <linux|darwin|win32> --arch <x64|arm64>`, `bare-make build`,
`bare-make install --prefix prebuilds`. This is upstream's
[compile-prebuilds action](https://github.com/holepunchto/actions/blob/v1/compile-prebuilds/action.yml).
Our `.github/workflows/auth-native-lock.yml` configures prebuilt Node20/22 and source-build jobs for
Linux/macOS/Windows, with no upload/publish; every job runs real-process lifecycle/exchange tests.
Source-building requires network/toolchain dependencies; npm normal install has no source fallback script.

## Security/platform limits and verification

- Local private filesystem only. NFS/SMB/cloud-synced credentials and concurrent uncooperative writers are
  not supported. Lock files must not be renamed/deleted by operators while clients are running.
- POSIX directory0700/file0600 are enforced best effort as before. Windows mode bits do **not** establish
  an equivalent ACL: use a user-private credential directory and verify NTFS ACLs independently.
- Linux x64 packaged native prebuild tested locally: 4 actual Node processes → one refresh HTTP; force
  coalescing; revision adoption; actual provider logout/login child processes; owner SIGKILL recovery;
  timeout release; terminal invalid_grant. Native tests additionally cover backdated live-owner mtime,
  responsive event loop, canceled/bounded waits, permanent inode, callback failure and absent binding.
- macOS/Windows sources and packaged binaries inspected, CI matrix configured; **not run here**. Source
  rebuild jobs are configured but **not locally executed**. No cross-platform execution success claimed.
- npm audit currently reports four existing dependency advisories (connect-node/busboy/undici/zod);
  none is introduced by this native lock dependency. No broad dependency upgrade performed.
- OAuth live refresh remains untested/unexecuted; mock HTTP is not live protocol evidence.
