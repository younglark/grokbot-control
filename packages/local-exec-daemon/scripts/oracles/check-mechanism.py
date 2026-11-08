"""Mechanism gates for t108 review (retry drop / expiry / lane fairness). Usage: check-mechanism.py MODE official.json ours.json"""
import json,sys
mode,o,u=sys.argv[1],json.load(open(sys.argv[2])),json.load(open(sys.argv[3]))
def kinds(d):
  return [next(iter(f['message']['shellStream'])) if 'shellStream' in (f['message'] or {}) else 'streamClose' if 'streamClose' in (f['message'] or {}) else 'other' for f in d['accepted']]
def late(d): return next((i+1 for i,b in enumerate(d['busyBatches']) if 'busyLane256' in b['ids']),None)
def sizes(d): return [len(b['ids']) for b in d['busyBatches']]
if mode=='retry':
  a,b=kinds(o),kinds(u);print('accepted kinds official=',a,'ours=',b);ok=a==b
elif mode=='expiry':
  # after the 30 s closing budget no data submit is retried; compare last data attempt time (±1.5 s) and accepted kinds
  lo=max(x['t'] for x in o['attempts']);lu=max(x['t'] for x in u['attempts']);a,b=kinds(o),kinds(u)
  print('last attempt official=',lo,'ours=',lu,'accepted',a,b);ok=a==b and abs(lo-lu)<=1500 and lu<34000
elif mode=='fair':
  a,b=late(o),late(u);print('late lane first batch official=',a,'ours=',b,'sizes',sizes(o),sizes(u));ok=a==b and a is not None
else: raise SystemExit(2)
print('PASS' if ok else 'FAIL');sys.exit(0 if ok else 1)
