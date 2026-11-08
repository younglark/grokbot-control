#!/usr/bin/env python3
"""Compare uc-keepalive.cjs results: official golden vs ours.
Usage: keepalive-diff.py OFFICIAL.json OURS.json [--tol-ms 300]
Exact: scenario, results all pass, keepalive count and id lists in order, cancelled-backlog (sh8) messages.
Timed: each keepalive offset (t - enqueued) within tolerance (official tick 500ms; jitter is scheduling).
Not compared (documented deviation): data-submit batching (dataSeq shapes).
"""
import json, sys
a = sys.argv[1:]; tol = 300
if '--tol-ms' in a: i = a.index('--tol-ms'); tol = int(a[i + 1]); del a[i:i + 2]
o, u = (json.load(open(f)) for f in a)
bad = []
for side, d in (('official', o), ('ours', u)):
    if not d.get('results') or any(r.get('status') != 'pass' for r in d['results']): bad.append(f'{side} results not pass')
if o['scenario'] != u['scenario']: bad.append('scenario mismatch')
ko, ku = o['keepalives'], u['keepalives']
if [k['ids'] for k in ko] != [k['ids'] for k in ku]: bad.append(f'keepalive ids differ: {[k["ids"] for k in ko]} vs {[k["ids"] for k in ku]}')
else:
    for x, y in zip(ko, ku):
        dx, dy = x['t'] - o['marks']['enqueued'], y['t'] - u['marks']['enqueued']
        if abs(dx - dy) > tol: bad.append(f'keepalive offset {dx} vs {dy} > {tol}ms')
if o['scenario'] == 'cancel' and o.get('sh8') != u.get('sh8'): bad.append(f'cancelled backlog frames differ: {o.get("sh8")} vs {u.get("sh8")}')
print(('FAIL ' + '; '.join(bad)) if bad else f'SAME {o["scenario"]} keepalives={len(ko)}')
sys.exit(1 if bad else 0)
