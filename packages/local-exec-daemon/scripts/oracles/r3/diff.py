#!/usr/bin/env python3
"""Strict frame differential: official vs ours, with field-level deviation rules.

Usage: diff.py OFFICIAL.json OURS.json --probe NAME [--rules deviations.json] [--expected expected-cases.json]
Exit 0 only if:
  * both runs have non-empty results and events, every result is 'pass';
  * results names == event names (minus hello/r3) on each side, and equal the expected case list;
  * every case is identical after normalization, or identical after applying ONLY the narrow
    rules registered for that case. Each rule pins exact field values on both sides; a rule that
    does not match exactly is an error (so a case cannot silently drift into anything else).
Normalization: drop localExecutionTimeMs; merge consecutive same-stream stdout/stderr chunks.
"""
import json, sys, copy

def load(f):
    try: d = json.load(open(f))
    except Exception as e: return None, str(e)
    return d, None

def strip_timing(o):
    if isinstance(o, dict): return {k: strip_timing(v) for k, v in o.items() if k != 'localExecutionTimeMs'}
    if isinstance(o, list): return [strip_timing(x) for x in o]
    return o

def norm(frames):
    out = []
    for f in frames:
        f = strip_timing(f)
        ss = (f.get('message') or {}).get('shellStream') or {}
        key = next((k for k in ('stdout', 'stderr') if k in ss), None)
        if key and out and out[-1][0] == key and out[-1][1].get('requestId') == f.get('requestId') \
                and out[-1][1]['message'].get('id') == f['message'].get('id'):
            out[-1][1]['message']['shellStream'][key]['data'] += ss[key]['data']; continue
        out.append([key, f])
    return [f for _, f in out]

def get(o, path):
    for p in path: o = o[p]
    return o

def setp(o, path, v):
    for p in path[:-1]: o = o[p]
    o[path[-1]] = v

class RuleError(Exception): pass

def apply_rules(off, our, rules):
    """Returns (off', our') after rules. Raises RuleError if any rule does not match exactly."""
    off, our = copy.deepcopy(off), copy.deepcopy(our)
    sides = {'official': off, 'ours': our}
    # drops first, highest index first per side, so indices refer to normalized frames
    for r in sorted([r for r in rules if r['op'] == 'drop'], key=lambda r: -r['frame']):
        fr = sides[r['side']]
        if r['frame'] >= len(fr) or fr[r['frame']] != r['equals']:
            raise RuleError(f"drop rule {r['id']} frame mismatch")
        del fr[r['frame']]
    for r in rules:
        if r['op'] == 'field':
            try: a, b = get(off[r['frame']], r['path']), get(our[r['frame']], r['path'])
            except (KeyError, IndexError, TypeError): raise RuleError(f"field rule {r['id']} path missing")
            if a != r['official'] or b != r['ours']: raise RuleError(f"field rule {r['id']} value mismatch: {a!r} / {b!r}")
            setp(our[r['frame']], r['path'], a)
        elif r['op'] == 'sub':
            fr = sides[r['side']]
            try: v = get(fr[r['frame']], r['path'])
            except (KeyError, IndexError, TypeError): raise RuleError(f"sub rule {r['id']} path missing")
            for a, b in r['pairs']:
                if v.count(a) != 1: raise RuleError(f"sub rule {r['id']} expects exactly one {a!r}")
                v = v.replace(a, b)
            setp(fr[r['frame']], r['path'], v)
    return off, our

def main(argv):
    args = list(argv); opt = {}
    for k in ('--probe', '--rules', '--expected'):
        if k in args: i = args.index(k); opt[k] = args[i + 1]; del args[i:i + 2]
    if len(args) != 2 or '--probe' not in opt: print('usage: diff.py OFF OURS --probe NAME [--rules F] [--expected F]'); return 2
    probe = opt['--probe']
    rules = [r for r in (json.load(open(opt['--rules'])) if '--rules' in opt else []) if r['probe'] == probe]
    expected = json.load(open(opt['--expected']))[probe] if '--expected' in opt else None
    bad = 0; evs = []
    for label, f in (('official', args[0]), ('ours', args[1])):
        d, err = load(f)
        if d is None: print(f'ERROR {label} unreadable: {err}'); return 1
        res = d.get('results') or []; ev = {e['name']: e['frames'] for e in d.get('events', []) if 'frames' in e and e['name'] not in ('hello',)}
        ev.pop('r3', None)
        if not res or not ev: print(f'ERROR {label} empty results/events'); bad += 1
        failed = [r.get('name') for r in res if r.get('status') != 'pass']
        if failed: print(f'ERROR {label} probe steps failed: {failed}'); bad += 1
        rn = [r.get('name') for r in res]
        if sorted(rn) != sorted(ev): print(f'ERROR {label} results/events mismatch: results-only {sorted(set(rn)-set(ev))} events-only {sorted(set(ev)-set(rn))}'); bad += 1
        if expected is not None and sorted(ev) != sorted(expected):
            print(f'ERROR {label} case set != expected: missing {sorted(set(expected)-set(ev))} extra {sorted(set(ev)-set(expected))}'); bad += 1
        evs.append(ev)
    a, b = evs
    if set(a) != set(b): print('ERROR case set mismatch official/ours'); bad += 1
    same = diff = allowed = 0
    ruled_cases = {r['case'] for r in rules}
    for n in a:
        if n not in b: continue
        na, nb = norm(a[n]), norm(b[n])
        cr = [r for r in rules if r['case'] == n]
        if na == nb and not cr: same += 1; print('SAME   ', n); continue
        if na == nb and cr: print('ERROR  ', n, 'has rules but is identical (stale rule)'); bad += 1; continue
        if cr:
            try:
                xa, xb = apply_rules(na, nb, cr)
                if xa == xb:
                    allowed += 1; print('ALLOWED', n, [r['id'] for r in cr]); continue
                print('DIFF   ', n, '(differs beyond its rules)')
            except RuleError as e: print('DIFF   ', n, f'(rule did not apply: {e})')
        else: print('DIFF   ', n)
        diff += 1
        print('   off:', json.dumps(na)[:900]); print('   our:', json.dumps(nb)[:900])
    for c in ruled_cases - set(a): print('ERROR rule for absent case', c); bad += 1
    print(f'probe={probe} cases={len(a)} same={same} allowed={allowed} diff={diff} errors={bad}')
    return 1 if (diff or bad) else 0

if __name__ == '__main__': sys.exit(main(sys.argv[1:]))
