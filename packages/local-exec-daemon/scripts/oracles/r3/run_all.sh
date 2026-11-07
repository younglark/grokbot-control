#!/usr/bin/env bash
# Runs official + ours for every probe and the strict diff. Exit non-zero on any unexpected diff/probe failure.
set -u
here=$(cd "$(dirname "$0")" && pwd); OUT=${OUT:-/tmp/local-exec-oracle-r3}; export OUT
REPO=${REPO:-/workspace/grokbot-control}
rc=0
for p in main cancel cwd edges options rootlink; do
  PROBE=$p python3 "$here/run_r3.py" "official-$p" >/dev/null || { echo "probe official-$p failed"; rc=1; }
  PROBE=$p python3 "$here/run_r3.py" "ours-$p" PROBE_MAIN=/repo/packages/local-exec-daemon/dist/index.js "BIND:$REPO:/repo" >/dev/null || { echo "probe ours-$p failed"; rc=1; }
  echo "== $p"; python3 "$here/diff.py" "$OUT/official-$p.json" "$OUT/ours-$p.json" --allow-file "$here/deviations.json" | grep -E '^(DIFF|ALLOWED|ERROR|cases)' || true
  python3 "$here/diff.py" "$OUT/official-$p.json" "$OUT/ours-$p.json" --allow-file "$here/deviations.json" >/dev/null || rc=1
done
exit $rc
