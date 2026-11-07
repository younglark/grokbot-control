#!/usr/bin/env python3
"""Strict frame differential: official vs ours.

Usage: diff.py OFFICIAL.json OURS.json [--allow case1,case2] [--allow-file deviations.json]
Exit 0 only if: both probe runs completed (every probe step 'pass', non-empty event set),
both have the identical case set, and every case not explicitly allowed is identical.

Normalization is limited to: dropping localExecutionTimeMs (timing) and merging consecutive
stdout/stderr chunks of the same stream (pipe chunking). Message ids, requestId, kind, cwdState,
throw/error envelopes, exit codes, abort reasons and frame order are all compared.
"""
import json, sys

def load(f):
    d = json.load(open(f))
    res = d.get('results') or []
    failed = [r for r in res if r.get('status') != 'pass']
    ev = {e['name']: e['frames'] for e in d.get('events', []) if 'frames' in e and e['name'] != 'hello'}
    return ev, res, failed

def strip_timing(o):
    if isinstance(o, dict):
        return {k: strip_timing(v) for k, v in o.items() if k != 'localExecutionTimeMs'}
    if isinstance(o, list):
        return [strip_timing(x) for x in o]
    return o

def norm(frames):
    out = []
    for f in frames:
        f = strip_timing(f)
        ss = (f.get('message') or {}).get('shellStream') or {}
        key = next((k for k in ('stdout', 'stderr') if k in ss), None)
        if key and out and out[-1][0] == key and out[-1][1].get('requestId') == f.get('requestId'):
            prev = out[-1][1]['message']
            if prev.get('id') == f['message'].get('id'):
                prev['shellStream'][key]['data'] += ss[key]['data']
                continue
        out.append([key, f])
    return [f for _, f in out]

args = sys.argv[1:]
allow = set()
if '--allow' in args:
    i = args.index('--allow'); allow |= set(filter(None, args[i + 1].split(','))); del args[i:i + 2]
if '--allow-file' in args:
    i = args.index('--allow-file'); allow |= set(json.load(open(args[i + 1])).keys()); del args[i:i + 2]
a, ra, fa = load(args[0]); b, rb, fb = load(args[1])
bad = 0
if not a or not b: print('ERROR empty event set'); bad += 1
if fa: print('ERROR official probe steps failed:', fa); bad += 1
if fb: print('ERROR ours probe steps failed:', fb); bad += 1
if set(a) != set(b): print('ERROR case set mismatch: only-official', sorted(set(a) - set(b)), 'only-ours', sorted(set(b) - set(a))); bad += 1
same = diff = allowed = 0
for n in a:
    if n not in b: continue
    if norm(a[n]) == norm(b[n]):
        same += 1; print('SAME   ', n)
    elif n in allow:
        allowed += 1; print('ALLOWED', n, '(documented deviation)')
        print('   off:', json.dumps(norm(a[n]))[:900]); print('   our:', json.dumps(norm(b[n]))[:900])
    else:
        diff += 1; print('DIFF   ', n)
        print('   off:', json.dumps(norm(a[n]))[:900]); print('   our:', json.dumps(norm(b[n]))[:900])
print(f'cases={len(a)} same={same} allowed={allowed} diff={diff} errors={bad}')
sys.exit(1 if (diff or bad) else 0)
