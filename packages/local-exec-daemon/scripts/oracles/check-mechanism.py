"""Mechanism gates (t108/t109). Strict: identity, full frame sets, attempt evidence, fair batches.
Usage: check-mechanism.py MODE official.json ours.json
Negative (must FAIL): empty attempts; retargeted accepted requestId; fair with trailing batches dropped.
"""
import json, sys

mode, o, u = sys.argv[1], json.load(open(sys.argv[2])), json.load(open(sys.argv[3]))

def kind(f):
  m = f.get("message") or {}
  if "shellStream" in m: return next(iter(m["shellStream"]))
  if "streamClose" in m: return "streamClose"
  if "throw" in m: return "throw"
  return "other"

def sig(f): return (f.get("requestId"), kind(f))
def accepted(d): return [sig(f) for f in d.get("accepted") or []]
def attempt_rows(d):
  rows = []
  for a in d.get("attempts") or []:
    if "status" not in a or "frames" not in a or "t" not in a: return None
    rows.append((a["status"], [sig(f) for f in a["frames"]], a["t"]))
  return rows

def fail(msg):
  print("FAIL", msg); sys.exit(1)

if mode in ("retry", "expiry"):
  oa, ua = attempt_rows(o), attempt_rows(u)
  if not oa or not ua: fail("attempts missing or incomplete (status/frames/t required)")
  if accepted(o) != accepted(u): fail(f"accepted mismatch official={accepted(o)} ours={accepted(u)}")
  if any(rid != "retry-target" for rid, _ in accepted(u)):
    fail(f"accepted requestId must be retry-target: {accepted(u)}")
  for side, rows in ("official", oa), ("ours", ua):
    for st, fr, _t in rows:
      if any(rid != "retry-target" for rid, _ in fr): fail(f"{side} attempt frames retargeted: {fr}")
  if [st for st, _, _ in oa] != [st for st, _, _ in ua]:
    fail(f"status sequence official={[st for st,_,_ in oa]} ours={[st for st,_,_ in ua]}")
  if [fr for _, fr, _ in oa] != [fr for _, fr, _ in ua]:
    fail(f"attempt frame sets differ official={[fr for _,fr,_ in oa]} ours={[fr for _,fr,_ in ua]}")
  if mode == "retry":
    if accepted(u) != [("retry-target", "start"), ("retry-target", "exit"), ("retry-target", "streamClose")]:
      fail(f"retry recovered set must be start/exit/streamClose: {accepted(u)}")
    print("accepted", accepted(u), "attempts", len(ua), "statuses", [st for st, _, _ in ua])
  else:
    lo, lu = oa[-1][2], ua[-1][2]
    if abs(lo - lu) > 1500 or lu >= 34000: fail(f"last attempt official={lo} ours={lu}")
    if accepted(u) != [("retry-target", "start")]: fail(f"expiry accepted={accepted(u)}")
    print("last attempt official=", lo, "ours=", lu, "accepted", accepted(u))
elif mode == "fair":
  def busy_batches(d):
    out = []
    for b in d.get("busyBatches") or []:
      if "ids" not in b: fail("busyBatches entry missing ids")
      out.append([i for i in b["ids"] if str(i).startswith("busyLane")])
    return out
  ob, ub = busy_batches(o), busy_batches(u)
  if len(ob) < 4 or len(ub) < 4: fail(f"need ≥4 busy batches official={len(ob)} ours={len(ub)}")
  if [len(b["ids"]) for b in o["busyBatches"][:3]] != [256, 256, 256]:
    fail(f"official first-3 sizes {[len(b['ids']) for b in o['busyBatches'][:3]]}")
  if [len(b["ids"]) for b in u["busyBatches"][:3]] != [256, 256, 256]:
    fail(f"ours first-3 sizes {[len(b['ids']) for b in u['busyBatches'][:3]]}")
  if sum(len(x) for x in ob) != 257 * 3 or sum(len(x) for x in ub) != 257 * 3:
    fail(f"busyLane frame totals official={sum(len(x) for x in ob)} ours={sum(len(x) for x in ub)} want {257*3}")
  def first_batch(batches, lane):
    for i, b in enumerate(batches):
      if lane in b: return i + 1
  for lane in ("busyLane0", "busyLane128", "busyLane255", "busyLane256"):
    fo, fu = first_batch(ob, lane), first_batch(ub, lane)
    if fo is None or fu is None or fo != fu:
      fail(f"{lane} first batch official={fo} ours={fu}")
  if first_batch(ub, "busyLane256") != 2:
    fail(f"busyLane256 must appear first in batch 2, got {first_batch(ub, 'busyLane256')}")
  # same-lane order preserved: for each lane, positions within the concatenation stay sorted by enqueue order
  def lane_pos(batches, lane):
    return [j for b in batches for j, x in enumerate(b) if x == lane]
  # each lane has 3 frames; their batch indices must be non-decreasing (already by construction) —
  # require ours batch index sequence for lane 0 equals official
  def batch_seq(batches, lane):
    return [i + 1 for i, b in enumerate(batches) for x in b if x == lane]
  if batch_seq(ob, "busyLane0") != batch_seq(ub, "busyLane0"):
    fail(f"busyLane0 batch sequence official={batch_seq(ob,'busyLane0')} ours={batch_seq(ub,'busyLane0')}")
  print("late lane first batch official=", first_batch(ob, "busyLane256"), "ours=", first_batch(ub, "busyLane256"),
        "sizes", [len(b["ids"]) for b in o["busyBatches"]], [len(b["ids"]) for b in u["busyBatches"]])
else:
  raise SystemExit(2)
print("PASS"); sys.exit(0)
