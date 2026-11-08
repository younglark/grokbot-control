import json,sys
for path in sys.argv[1:]:
 d=json.load(open(path));aborts=[c['t']-d['marks']['cancel'] for c in d['closes'] if not c['ended'] and c['ids']==['target'] and c['t']>=d['marks']['cancel']]
 ok=d['cancelAcked'] and bool(d['targetExit']) and bool(aborts) and min(aborts)<=300
 print(('PASS' if ok else 'FAIL')+' active cancel reachable within 300ms: '+path+' ack='+str(d['cancelAcked'])+' abort_delays='+str(aborts))
 if not ok:sys.exit(1)
