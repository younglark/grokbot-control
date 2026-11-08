"""Mechanism gates (t108–t112): official retry/backoff model + full-content comparison.
Usage: check-mechanism.py MODE official.json ours.json   (MODE: retry | expiry | fair)

Normalization (explicit, only legitimately varying values): `localExecutionTimeMs` at any depth is removed;
attempt wall times are checked against the model below, not ignored. Everything else (requestIds, frame
kinds, exit codes, abort fields, exec ids, cwd, frame order, per-attempt status) is compared exactly, and each
side's `accepted` must equal the concatenation of that side's HTTP-200 attempt frames.

retry/expiry — each side must independently satisfy the official submit/flush model (L178671–178760):
  * a round is up to 3 attempts; consecutive attempts inside a round are 200 ms apart (±TOL); a round ends on
    HTTP 200 or after exactly 3 failures (a failure round with 1, 2 or ≥4 attempts fails the gate);
  * after an exhausted round the next *scheduled* round starts closing-backoff later: 500·2^k ms capped at
    4000 ms (k = exhausted scheduled rounds since the last success − 1), measured from the exhausted round's last
    attempt (±TOL); a shorter gap is allowed only as a *wake* round: a Watch request (evidence: `watches[].t`,
    official connected → flush) arrived after the previous attempt and ≤ WAKE_MS before the wake round's first
    attempt. A wake round does not move the backoff timer (official `closingRetryWait ??=`).
  Then the scheduled rounds are compared with official: same count, same (status, normalized frames) per
  attempt, round start (relative to enqueue) within ±TOL_START; wake rounds must carry exactly the frames of
  the preceding scheduled round. No run-length collapsing.
fair: every batch (all ids, not only busyLane) ≤ 256 frames; the full id sequence of every batch and every
  frame's normalized content equal official's; busyLane multiset exactly busyLane0..256 × 3.
"""
import json, sys

TOL, TOL_START, WAKE_MS = 50, 300, 150
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
  if acc != norm([f for x in a if x["status"] == 200 for f in x["frames"]]): fail(f"{side}: accepted differs from its HTTP-200 attempt frames")
  return a, acc

def rounds(a, d, side):
  """Split into rounds, enforce the model, return [(kind, [attempts])] with kind 'scheduled' | 'wake'."""
  watches = sorted(w["t"] for w in d.get("watches") or [])
  out, cur = [], []
  for x in a:
    cur.append(x)
    if x["status"] == 200 or len(cur) == 3: out.append(cur); cur = []
  if cur: fail(f"{side}: trailing round of {len(cur)} failed attempt(s) at t={cur[0]['t']} (official makes exactly 3)")
  res, exhausted, last_sched_end = [], 0, None
  for i, r in enumerate(out):
    for p, q in zip(r, r[1:]):
      if abs(q["t"] - p["t"] - 200) > TOL: fail(f"{side}: attempts {p['t']}→{q['t']} not 200 ms apart inside a round")
    kind = "scheduled"
    if i > 0 and out[i - 1][-1]["status"] != 200:
      prev_end = out[i - 1][-1]["t"]
      want = min(500 * 2 ** (exhausted - 1), 4000)
      gap = r[0]["t"] - last_sched_end
      if abs(gap - want) > TOL:
        if any(prev_end < w <= r[0]["t"] and r[0]["t"] - w <= WAKE_MS for w in watches): kind = "wake"
        else: fail(f"{side}: round at {r[0]['t']} starts {gap} ms after the exhausted round (want {want}±{TOL}) with no Watch wake evidence")
    if kind == "scheduled":
      exhausted = 0 if r[-1]["status"] == 200 else exhausted + 1
      last_sched_end = r[-1]["t"]
    res.append((kind, r))
  return res

def key(r): return [(x["status"], norm(x["frames"])) for x in r]

if mode in ("retry", "expiry"):
  oa, oacc = check_side(o, "official"); ua, uacc = check_side(u, "ours")
  ro, ru = rounds(oa, o, "official"), rounds(ua, u, "ours")
  for side, rs in (("official", ro), ("ours", ru)):
    for i, (k, r) in enumerate(rs):
      if k == "wake" and key(r) != key(rs[i - 1][1]) and not (i >= 2 and key(r) == key(rs[i - 2][1])):
        fail(f"{side}: wake round at {r[0]['t']} carries different frames than the preceding round")
  so = [r for k, r in ro if k == "scheduled"]; su = [r for k, r in ru if k == "scheduled"]
  if len(so) != len(su): fail(f"scheduled rounds official={len(so)} ours={len(su)}")
  mo, mu = o["marks"]["enqueued"], u["marks"]["enqueued"]
  for i, (x, y) in enumerate(zip(so, su)):
    if key(x) != key(y): fail(f"scheduled round {i} (status, frames) differ")
    if abs((y[0]["t"] - mu) - (x[0]["t"] - mo)) > TOL_START: fail(f"scheduled round {i} starts {x[0]['t'] - mo} vs {y[0]['t'] - mu} ms after enqueue")
  if oacc != uacc: fail("accepted frames differ (full content)")
  print("scheduled", len(so), "wake official", sum(k == "wake" for k, _ in ro), "ours", sum(k == "wake" for k, _ in ru), "attempts", len(oa), len(ua))
elif mode == "fair":
  want = sorted(f"busyLane{i}" for i in range(257) for _ in range(3))
  def batches(d, side):
    bb = d.get("busyBatches")
    if not isinstance(bb, list) or not bb: fail(f"{side}: busyBatches missing")
    for b in bb:
      if len(b["ids"]) > 256: fail(f"{side}: batch of {len(b['ids'])} frames > 256")
      if "frames" not in b or len(b["frames"]) != len(b["ids"]) or [f["requestId"] for f in b["frames"]] != b["ids"]: fail(f"{side}: batch frames missing/inconsistent with ids")
    if sorted(i for b in bb for i in b["ids"] if str(i).startswith("busyLane")) != want: fail(f"{side}: busyLane multiset is not busyLane0..256 ×3")
    return bb
  ob, ub = batches(o, "official"), batches(u, "ours")
  if len(ob) != len(ub): fail(f"batch count official={len(ob)} ours={len(ub)}")
  for i, (x, y) in enumerate(zip(ob, ub)):
    if x["ids"] != y["ids"]: fail(f"batch {i+1} id sequence differs")
    if norm(x["frames"]) != norm(y["frames"]): fail(f"batch {i+1} frame content differs")
  print("batches", [len(b["ids"]) for b in ub])
else:
  raise SystemExit(2)
print("PASS"); sys.exit(0)
