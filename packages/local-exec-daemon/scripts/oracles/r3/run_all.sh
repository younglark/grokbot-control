#!/usr/bin/env bash
# Runs official + ours for every probe, the strict field-level diff, and the ours-only lifecycle
# probe. Exit non-zero on any unexpected diff, missing/failed probe, or case-set mismatch.
set -u
here=$(cd "$(dirname "$0")" && pwd); OUT=${OUT:-/tmp/local-exec-oracle-r3}; export OUT
REPO=${REPO:-/workspace/grokbot-control}
rc=0
for p in main cancel cwd edges options rootlink locale cwdpersist; do
  PROBE=$p python3 "$here/run_r3.py" "official-$p" >/dev/null || { echo "probe official-$p failed"; rc=1; }
  PROBE=$p python3 "$here/run_r3.py" "ours-$p" PROBE_MAIN=/repo/packages/local-exec-daemon/dist/index.js "BIND:$REPO:/repo" >/dev/null || { echo "probe ours-$p failed"; rc=1; }
  python3 "$here/diff.py" "$OUT/official-$p.json" "$OUT/ours-$p.json" --probe "$p" --rules "$here/deviations.json" --expected "$here/expected-cases.json" >"$OUT/diff-$p.txt"; d=$?
  grep -E '^(DIFF|ALLOWED|ERROR|probe=)' "$OUT/diff-$p.txt"; [ $d -eq 0 ] || rc=1
done
# ours-only: shutdown kills the shared init group; a failed emit settles the lifecycle.
bwrap --unshare-all --die-with-parent --new-session --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 --symlink usr/bin /bin \
  --proc /proc --dev /dev --tmpfs /tmp --tmpfs /state --ro-bind /home/box/.local/node/bin /runtime --ro-bind "$REPO" /repo \
  --ro-bind "$here/probes" /p --clearenv --setenv PATH /runtime:/usr/bin:/bin /runtime/node /p/probe_lifecycle.cjs >"$OUT/ours-lifecycle.txt" 2>&1 \
  && grep -q 'LIFECYCLE PASS' "$OUT/ours-lifecycle.txt" && echo "lifecycle PASS" || { echo "lifecycle FAIL"; rc=1; }
echo "RC=$rc"; exit $rc
