# Atomic file writer cp

**Original cp (D:80591–80603), default path (no noFollow).**
1. yLe: `mkdirSync(dirname, {recursive: true})`.
2. MFt (D:80604): an in-process FIFO lock table `ece: Map<path.resolve(target), resolver[]>`. The first waiter runs; leave() shifts the queue and wakes the next; an empty queue deletes the key. There is no cross-process lock.
3. AFt:
   - realpath(target), with ENOENT → the target itself (DFt);
   - mode = options.mode ?? stat(real).mode, with ENOENT → undefined (BFt);
   - temp = `${real}.${randomInt(2**32)}` (ice, wFt).
4. gLe (D:80642):
   - `open(temp, O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, mode ?? 0o666)`;
   - writeFile(fd);
   - fchmod(fd, mode) only when mode is defined, tolerating ELe (ENOSYS, or EINVAL/EPERM when not root);
   - **fsync(fd)**;
   - close;
   - rename(temp, real).
   - Any failure → rm(temp, {force}) and rethrow.
   - **The directory is never fsynced.**

**Callers, ported to the shared `src/state/fs-write.ts`:**

| Caller | Original | Mode | Notes |
|---|---|---|---|
| discovery | CLe → TLe pretty (D:80993) | no mode (it was 0600 before) | pretty JSON |
| connection | vLe (D:80967) | 0600 | sealed or plain |
| retirements | D:81363 | no mode (it was 0600 before) | the per-path gUe lock is kept |
| upload | D:136382 | no mode | before t159 we had our own approximation that always chmodded to 0o666 or the old mode |

- Not ported: the spent-sends file (xUe, unreachable on Linux), YR (the synchronous settings writer, D:82195; this port does not write settings), and the noFollow variant (xFt/SLe).
- Tests: in `test/t159-exchange-obsidian-cp.test.cjs` — FIFO queue length 2 for two spellings of one path; operation order fsync → rename; fchmod only when a mode exists; 0o666 & ~umask for a new file; an existing mode preserved; an explicit 0600; a symlink target replaced; rename failure cleans up the temp file.
