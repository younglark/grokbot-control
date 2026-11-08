"""Mechanism gates (t108–t110): full-content comparison after explicit normalization.
Usage: check-mechanism.py MODE official.json ours.json   (MODE: retry | expiry | fair)
Normalization (only legitimately varying values): `localExecutionTimeMs` at any depth, attempt wall
times `t` (expiry compares the last attempt time within ±1.5 s). Everything else — requestIds, frame
kinds, exit codes, abort fields, exec ids, cwd, frame order, per-attempt status — must be identical, and
each side's `accepted` must equal the concatenation of that side's HTTP-200 attempt frames.
Fair: the busyLane frames of every batch, in order, must equal official's, and the lane multiset must be
exactly busyLane0..busyLane256 × 3.
"""
import json, sys

mode, o, u = sys.argv[1], json.load(open(sys.argv[2])), json.load(open(sys.argv[3]))
VOLATILE = {"localExecutionTimeMs"}

def norm(x):
  if isinstance(x, dict): return {k: norm(v) for k, v in sorted(x.items()) if k not in VOLATILE}
  if isinstance(x, list): return [norm(v) for v in x]
  return x

def fail(msg): print("FAIL", msg); sys.exit(1)

def attempts(d, side):
  a = d.get("attempts")
  if not isinstance(a, list) or not a: fail(f"{side}: attempts missing/empty")
  for x in a:
    if not {"t", "status", "frames"} <= set(x): fail(f"{side}: attempt lacks t/status/frames")
  return a

def check_side(d, side):
  a = attempts(d, side)
  acc = norm(d.get("accepted") or [])
  ok200 = norm([f for x in a if x["status"] == 200 for f in x["frames"]])
  if acc != ok200: fail(f"{side}: accepted differs from its HTTP-200 attempt frames")
  return a, acc

if mode in ("retry", "expiry"):
  oa, oacc = check_side(o, "official"); ua, uacc = check_side(u, "ours")
  if mode == "retry":
    if [x["status"] for x in oa] != [x["status"] for x in ua]:
      fail(f"status sequence official={[x['status'] for x in oa]} ours={[x['status'] for x in ua]}")
    for i, (x, y) in enumerate(zip(oa, ua)):
      if norm(x["frames"]) != norm(y["frames"]): fail(f"attempt {i} frames differ")
  else:
    # Expiry: the number of identical closing-retry rounds may differ (official makes one extra early
    # flush when its Watch silence watchdog t9r=15 s reconnects, which ours does not implement; see
    # REVIEW-FIXES). Compared exactly: the run-length-collapsed sequence of (status, full frames).
    def collapse(a):
      out = []
      for x in a:
        k = (x["status"], json.dumps(norm(x["frames"]), sort_keys=True))
        if not out or out[-1] != k: out.append(k)
      return out
    if collapse(oa) != collapse(ua): fail("collapsed (status, frames) sequence differs")
    print("attempt rounds official=", len(oa), "ours=", len(ua), "(collapsed equal)")
  if oacc != uacc: fail("accepted frames differ (full content)")
  if mode == "expiry":
    lo, lu = oa[-1]["t"], ua[-1]["t"]
    if abs(lo - lu) > 1500: fail(f"last attempt official={lo} ours={lu}")
    print("last attempt official=", lo, "ours=", lu)
  print("attempts", len(ua), "statuses", [x["status"] for x in ua], "accepted", len(uacc))
elif mode == "fair":
  want = sorted(f"busyLane{i}" for i in range(257) for _ in range(3))
  def lanes(d, side):
    bb = d.get("busyBatches")
    if not isinstance(bb, list) or not bb: fail(f"{side}: busyBatches missing")
    out = [[i for i in b["ids"] if str(i).startswith("busyLane")] for b in bb]
    if sorted(i for b in out for i in b) != want: fail(f"{side}: busyLane multiset is not busyLane0..256 ×3")
    return out
  ob, ub = lanes(o, "official"), lanes(u, "ours")
  if len(ob) != len(ub): fail(f"batch count official={len(ob)} ours={len(ub)}")
  for i, (x, y) in enumerate(zip(ob, ub)):
    if x != y: fail(f"batch {i+1} busyLane sequence differs")
  print("batches", [len(b) for b in ub])
else:
  raise SystemExit(2)
print("PASS"); sys.exit(0)
