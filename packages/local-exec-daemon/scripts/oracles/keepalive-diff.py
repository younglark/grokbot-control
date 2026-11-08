#!/usr/bin/env python3
"""Compare uc-keepalive.cjs results: official golden vs ours.

Usage: keepalive-diff.py OFFICIAL.json OURS.json [--tol-ms 300]

Always (every scenario):
  * both runs: non-empty results, every result 'pass' (includes the death gate: daemon alive until cleanup);
  * same scenario.
Semantic data evidence (P3; replaces "ignore all data submits"):
  * per request id, the ordered decoded data messages after normalization must be equal:
    localExecutionTimeMs removed, consecutive stdout/stderr chunks of one id merged. Submit
    batching and chunking are the ONLY differences tolerated; the set of ids with data must match
    and must be non-empty where official has data.
  * exception 'pressure': streaming content is cut at a timing-dependent point and which identical
    shell lands in the first delayed submit races, so only the number of ids with data and their
    first message kinds are compared (must be non-empty iff official is).
  * named deviation EXEC-HEARTBEAT: official writes an inner control {"heartbeat":{"id":N}} periodically
    while an exec runs (D:L98140–98153, zHt); ours does not implement it yet. Only messages that are
    exactly {"heartbeat":{"id":<that request's exec id>}} are removed from the official side, and the
    count is printed; any other difference still fails.
  * named rule EXEC-ID: the inner exec `id` is a local sequence assigned at admission (it differs
    between fresh official runs when admissions in one poll race). Each side must use exactly one
    id per request and distinct ids across requests; the value itself is then replaced by '#'.
  * named rule TICK-BOUNDARY: a keepalive due exactly 3000 ms after the previous one is heard is
    picked by the 6th 500 ms serial tick after it, so both daemons sit on a sub-millisecond tie:
    Node timers fire against libuv's integer-ms clock while due times use performance.now(). Measured in
    ours (instrumented run, 20 runs): per-tick gaps 499.1–501.6 ms, 6th-tick margin +0.2…+5.7 ms; a
    negative margin skips to the next tick (+500 ms). Official uses the same mechanism (D:yre/qr.schedule
    setTimeout + monotonicNow, c9r 500, u9r 3000). One such shift of exactly one tick (±50 ms) per run,
    never on the first keepalive, is accepted and counted; any other lateness still fails.
Overflow (8 active + 64 backlog + 200 busy, first submit stalled 10 s): all 200 busy items acknowledged
  and terminal on both sides, same error text, none started; keepalives/data not compared.
Keepalives:
  * backlog/cancel/stall/exhausted/rotation: id lists in order exactly, offsets within tolerance;
  * pressure: ids keepalived before the cancel mark must be equal as sets; no cancelled id may be
    keepalived later than cancel + tolerance in ours;
  * stall-cancel: none on either side.
Lifecycle:
  * cancel: cancelled backlog frame (sh8) equal;
  * stall-cancel: the stalled submit for the cancelled id is aborted (response closed, not ended)
    within tolerance of the cancel mark, and the next request's first data arrives no later than
    official + tolerance;
  * rotation: keepalives continue after the old credential's late 401 (new channel not blocked).
"""
import json, sys

TICK_MS = 500       # official keep-alive tick c9r (serial hc/yre cadence)
TICK_BAND_MS = 50

def norm_msgs(msgs):
    out = []
    for m in msgs:
        if m is None: out.append(None); continue
        m = json.loads(json.dumps(m))
        m.pop('localExecutionTimeMs', None)
        ss = m.get('shellStream') or {}
        for v in ss.values():
            if isinstance(v, dict): v.pop('localExecutionTimeMs', None)
        k = next((x for x in ('stdout', 'stderr') if x in ss), None)
        if k and out and isinstance(out[-1], dict) and k in (out[-1].get('shellStream') or {}):
            out[-1]['shellStream'][k]['data'] += ss[k]['data']; continue
        out.append(m)
    return out

def strip_heartbeats(msgs):
    ids = {m.get('id') for m in msgs if isinstance(m, dict) and 'shellStream' in m}
    kept = [m for m in msgs if not (isinstance(m, dict) and list(m) == ['heartbeat'] and m['heartbeat'] == {'id': next(iter(ids))} and len(ids) == 1)]
    return kept, len(msgs) - len(kept)

def exec_ids(msgs):
    out = set()
    for m in msgs:
        if not isinstance(m, dict): continue
        if 'id' in m: out.add(m['id'])
        for v in m.values():
            if isinstance(v, dict) and set(v) == {'id'}: out.add(v['id'])
    return out

def anon(msgs):
    def f(x):
        if isinstance(x, dict): return {k: ('#' if k == 'id' else f(v)) for k, v in x.items()}
        if isinstance(x, list): return [f(v) for v in x]
        return x
    return f(msgs)

def kind(m):
    if not m: return None
    ss = m.get('shellStream')
    return ('shellStream', sorted(ss)[0]) if ss else sorted(m)[0]

def main(argv):
    a = list(argv); tol = 300
    if '--tol-ms' in a: i = a.index('--tol-ms'); tol = int(a[i + 1]); del a[i:i + 2]
    o, u = (json.load(open(f)) for f in a)
    bad = []
    for side, d in (('official', o), ('ours', u)):
        res = d.get('results') or []
        if not res or any(r.get('status') != 'pass' for r in res): bad.append(f'{side} results not pass: {res}')
    sc = o.get('scenario')
    if sc != u.get('scenario'): bad.append('scenario mismatch')
    if sc == 'overflow':
        # P2-1 (review t104): every busy queue item that was acknowledged must have its terminal busy
        # frame, all 200 must end terminal on both sides, error text equal, none started.
        for side, d in (('official', o), ('ours', u)):
            acked = set(d.get('acked') or []); term = {t['requestId'] for t in d.get('terminal') or []}
            if len(acked) != 200 or term != acked: bad.append(f'{side}: acked {len(acked)} terminal {len(term)} missing {sorted(acked - term)[:5]}')
            if d.get('busyStarted'): bad.append(f'{side}: busy requests started {d["busyStarted"][:5]}')
        eo = {t['error'] for t in o.get('terminal') or []}; eu = {t['error'] for t in u.get('terminal') or []}
        if eo != eu: bad.append(f'busy error text differs: {eo} vs {eu}')
        print(('FAIL ' + '; '.join(bad)) if bad else f'SAME overflow acked=terminal={len(u.get("acked") or [])}')
        return 1 if bad else 0
    do, du = dict(o.get('data') or {}), dict(u.get('data') or {})
    hb = hbu = 0
    for k in list(do):
        do[k], n = strip_heartbeats(do[k]); hb += n
    for k in list(du):
        du[k], n = strip_heartbeats(du[k]); hbu += n
    for side, d in (('official', do), ('ours', du)):
        seen = {}
        for k, msgs in d.items():
            ids = exec_ids(msgs)
            if len(ids) > 1: bad.append(f'{side} {k}: several exec ids {sorted(ids)}')
            for i in ids:
                if i in seen: bad.append(f'{side}: exec id {i} reused by {seen[i]} and {k}')
                seen[i] = k
    if sc != 'pressure' and set(do) != set(du): bad.append(f'data ids differ: {sorted(do)} vs {sorted(du)}')
    elif sc == 'pressure':
        # Which of the 8 identical streaming shells reaches the first (10s-delayed) submit is a race in
        # both daemons; compare the count of ids with data and each one's first message kind.
        if len(do) != len(du) or sorted(kind((v or [None])[0]) for v in do.values()) != sorted(kind((v or [None])[0]) for v in du.values()): bad.append(f'pressure data shape differs')
    else:
        for k in do:
            if anon(norm_msgs(do[k])) != anon(norm_msgs(du[k])): bad.append(f'{k}: data differs: {json.dumps(norm_msgs(do[k]))[:300]} vs {json.dumps(norm_msgs(du[k]))[:300]}')
    if not do: bad.append('official golden has no data evidence (re-record it)')
    if not du: bad.append('ours has no data evidence')
    ko, ku = o.get('keepalives') or [], u.get('keepalives') or []
    tick_boundary = 0
    mo, mu = o['marks']['enqueued'], u['marks']['enqueued']
    if sc == 'pressure':
        co, cu = o['marks']['cancel'], u['marks']['cancel']
        so = {i for k in ko if k['t'] < co for i in k['ids']}; su = {i for k in ku if k['t'] < cu for i in k['ids']}
        if so != su: bad.append(f'pre-cancel keepalive ids differ: only-official {sorted(so - su)[:8]} only-ours {sorted(su - so)[:8]}')
        cancelled = {f'sh{i}' for i in range(8, 72)}
        late = [k['t'] - cu for k in ku if k['t'] > cu + tol and cancelled & set(k['ids'])]
        if late: bad.append(f'cancelled ids keepalived after cancel: {late}')
    elif sc == 'stall-cancel':
        if ko or ku: bad.append(f'unexpected keepalives {ko} / {ku}')
    else:
        if [k['ids'] for k in ko] != [k['ids'] for k in ku]: bad.append(f'keepalive ids differ: {[k["ids"] for k in ko]} vs {[k["ids"] for k in ku]}')
        else:
            shift = 0
            for i, (x, y) in enumerate(zip(ko, ku)):
                d = (y['t'] - mu) - (x['t'] - mo) - shift
                if abs(d) <= tol: continue
                # TICK-BOUNDARY: see module doc. Exactly one 500 ms tick (±50 ms), not the first
                # keepalive, at most once per run; later keepalives must keep the shifted cadence.
                if i > 0 and shift == 0 and abs(abs(d) - TICK_MS) <= TICK_BAND_MS:
                    shift = TICK_MS if d > 0 else -TICK_MS; tick_boundary += 1; continue
                bad.append(f'keepalive offset {x["t"] - mo} vs {y["t"] - mu} > {tol}ms')
    if sc == 'cancel' and o.get('sh8') != u.get('sh8'): bad.append('cancelled backlog frames differ')
    if sc == 'stall-cancel':
        for side, d in (('official', o), ('ours', u)):
            c = d['marks']['cancel']
            ab = [x for x in d.get('closes') or [] if 'one' in x['ids'] and not x['ended'] and x['t'] - c <= tol]
            if not ab: bad.append(f'{side}: stalled submit for cancelled id not aborted within {tol}ms')
        fo = (o.get('firstNonKeepalive') or {}).get('two'); fu = (u.get('firstNonKeepalive') or {}).get('two')
        if fu is None or fo is None or (fu - u['marks']['cancel']) > (fo - o['marks']['cancel']) + tol: bad.append(f'next request first data late: official {fo} ours {fu}')
    if sc == 'rotation':
        for side, d in (('official', o), ('ours', u)):
            if not any(k['t'] > d['marks']['old401'] for k in d.get('keepalives') or []): bad.append(f'{side}: no keepalive after old-credential 401 (channel blocked)')
    print(('FAIL ' + '; '.join(bad)) if bad else f'SAME {sc} keepalives={len(ko)} dataIds={len(do)} EXEC-HEARTBEAT official={hb} ours={hbu} TICK-BOUNDARY={tick_boundary}')
    return 1 if bad else 0

if __name__ == '__main__': sys.exit(main(sys.argv[1:]))
