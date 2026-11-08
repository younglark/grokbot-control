import json,sys
for path in sys.argv[1:]:
 d=json.load(open(path));throws=[m['throw'] for m in d['queuedTargetTerminal'] if isinstance(m,dict) and 'throw' in m]
 ok=d['cancelAcked'] and not d['targetStarted'] and any(x.get('error')=="Cancelled before it started on the user's computer." for x in throws)
 print(('PASS' if ok else 'FAIL')+' cancelled backlog terminal retained: '+path+' terminal_count='+str(len(throws)))
 if not ok:sys.exit(1)
